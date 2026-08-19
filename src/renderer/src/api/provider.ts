/**
 * API provider: resolves the active HotClipApi implementation.
 *
 * - Inside Electron the preload script exposes `window.hotclip` (IPC-backed).
 * - In a plain browser (design preview today, web platform later) we fall back
 *   to a mock so the full UI stays renderable and testable without Electron.
 */
import type {
  HotClipApi,
  MediaInfo,
  Transcript,
  TranscribeProgressEvent,
  HighlightCandidate,
  DetectHighlightsResult,
  ExportProgressEvent,
  WatchEvent,
  GlossaryEntry,
} from "../../../shared/api-types";
import { applyGlossaryToTranscript, sanitizeGlossary } from "../../../shared/glossary";

const MOCK_MEDIA: MediaInfo = {
  durationSec: 5427.4, // 1:30:27 — a typical podcast episode
  hasVideo: true,
  hasAudio: true,
  width: 1920,
  height: 1080,
  fps: 29.97,
  bitRate: 4_500_000,
  videoCodec: "h264",
  audioCodec: "aac",
};

const MOCK_SENTENCES = [
  "大家好，欢迎来到我的直播间。",
  "今天给大家带来一款超级好用的纸巾，三层加厚，湿水不破。",
  "很多朋友问我，这个和超市里十几块的有什么区别。",
  "区别就在这里——你看这个吸水速度，直接倒半杯水都不带渗的。",
  "而且它是整箱装，算下来一包才两块多，真的闭眼入。",
  "喜欢的朋友点击下方小黄车，今天下单还送同款便携装。",
];

function mockTranscript(): Transcript {
  let t = 4.2;
  const segments = MOCK_SENTENCES.map((text, i) => {
    const dur = 2.2 + text.length * 0.14;
    const words = Array.from(text).map((ch, j) => ({
      text: ch,
      startSec: t + (dur * j) / text.length,
      endSec: t + (dur * (j + 1)) / text.length,
    }));
    const seg = { id: i + 1, startSec: t, endSec: t + dur, text, words };
    t += dur + 0.6;
    return seg;
  });
  return { language: "zh", segments, engine: "mock", durationSec: MOCK_MEDIA.durationSec };
}

type ProgressCb = (p: TranscribeProgressEvent) => void;
const progressListeners = new Set<ProgressCb>();
const emit = (p: TranscribeProgressEvent): void => progressListeners.forEach((cb) => cb(p));
type ExportCb = (p: ExportProgressEvent) => void;
const exportListeners = new Set<ExportCb>();
const emitExport = (p: ExportProgressEvent): void => exportListeners.forEach((cb) => cb(p));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
// 录播监听演示:启动后按剧本吐一轮事件
type WatchCb = (e: WatchEvent) => void;
const watchListeners = new Set<WatchCb>();
let watchRunning = false;
let watchDirDemo: string | null = null;
let webhookPortDemo: number | null = null;
const emitWatch = (e: Omit<WatchEvent, "at">): void => {
  if (watchRunning) watchListeners.forEach((cb) => cb({ ...e, at: Date.now() }));
};
let mockExportCancelled = false;
// 浏览器预览的词表持久化:localStorage 模拟主进程的 glossary.json
const GLOSSARY_LS_KEY = "hotclip-glossary";
function mockGlossaryLoad(): GlossaryEntry[] {
  try {
    return sanitizeGlossary(JSON.parse(localStorage.getItem(GLOSSARY_LS_KEY) ?? "[]"));
  } catch {
    return [];
  }
}

/** Browser-mode mock: deterministic fake data with realistic staged latency. */
const browserMock: HotClipApi = {
  async selectMedia() {
    await sleep(300);
    return "/demo/我的直播回放-2026-07-04.mp4";
  },
  async listAsrEngines() {
    await sleep(200);
    return [
      { id: "sensevoice", kind: "local", langs: ["zh", "yue", "en", "ja", "ko"], sizeMB: 170, speed: 3, accuracy: 1, uploads: false, installed: true },
      { id: "paraformer", kind: "local", langs: ["zh", "en"], sizeMB: 230, speed: 2, accuracy: 2, uploads: false, installed: false },
      { id: "fireredasr", kind: "local", langs: ["zh", "方言", "en"], sizeMB: 520, speed: 2, accuracy: 3, uploads: false, installed: false },
      { id: "elevenlabs", kind: "cloud", langs: ["90+", "zh", "en"], speed: 3, accuracy: 3, uploads: true, installed: false },
    ];
  },
  async probeMedia() {
    await sleep(600);
    return { ...MOCK_MEDIA };
  },
  async transcribeMedia() {
    const total = 170 * 1024 * 1024;
    for (let i = 1; i <= 4; i++) {
      emit({ fraction: 0, stage: "downloading-model", downloadedBytes: (total * i) / 4, totalBytes: total });
      await sleep(280);
    }
    emit({ fraction: 0, stage: "decoding" });
    await sleep(500);
    for (let i = 1; i <= 8; i++) {
      emit({ fraction: i / 8, stage: "transcribing" });
      await sleep(320);
    }
    emit({ fraction: 1, stage: "finalizing" });
    await sleep(250);
    // 与主进程同款:转写结果返回前自动应用热词词表
    return applyGlossaryToTranscript(mockTranscript(), mockGlossaryLoad()).transcript;
  },
  onTranscribeProgress(cb) {
    progressListeners.add(cb);
    return () => progressListeners.delete(cb);
  },
  async exportClips(_filePath, clips, options) {
    mockExportCancelled = false;
    const results = [];
    for (let i = 0; i < clips.length; i++) {
      if (mockExportCancelled) throw new Error("export cancelled");
      // 演示切片内实时编码进度
      for (let f = 0; f <= 1; f += 0.25) {
        emitExport({ current: i + 1, total: clips.length, clipId: clips[i].id, stage: "cutting", fraction: f });
        await sleep(220);
      }
      if (mockExportCancelled) throw new Error("export cancelled");
      emitExport({ current: i + 1, total: clips.length, clipId: clips[i].id, stage: "done" });
      results.push({
        id: clips[i].id,
        title: clips[i].title,
        path: `/Movies/HotClip/我的直播回放-2026-07-04/0${i + 1}-${clips[i].title}.mp4`,
        sizeBytes: 8_400_000 + i * 1_700_000,
        durationSec: clips[i].endSec - clips[i].startSec,
      });
    }
    // 与主进程同款:精华合集按时间序流复制拼接,附章节时间戳
    if (options?.compilation && results.length > 1) {
      results.push({
        id: 0,
        title: "精华合集",
        path: "/Movies/HotClip/我的直播回放-2026-07-04/00-精华合集.mp4",
        sizeBytes: results.reduce((a, r) => a + r.sizeBytes, 0),
        durationSec: results.reduce((a, r) => a + r.durationSec, 0),
      });
    }
    // 多画幅:横屏原画幅版落「横屏/」子目录(演示条目)
    if (options?.alsoLandscape && options?.vertical) {
      for (const r of results.filter((x) => x.id > 0)) {
        results.push({
          ...r,
          id: -r.id - 1,
          title: `${r.title}(横屏)`,
          path: r.path.replace("/我的直播回放-2026-07-04/", "/我的直播回放-2026-07-04/横屏/"),
        });
      }
    }
    return results;
  },
  onExportProgress(cb) {
    exportListeners.add(cb);
    return () => exportListeners.delete(cb);
  },
  cancelExport() {
    mockExportCancelled = true;
  },
  revealClip() {
    /* browser mock: nothing to reveal */
  },
  // 浏览器预览拿不到本地文件——审阅台的视频区退化为提示,时间轴仍可用
  mediaUrl: () => "",
  async selectImage() {
    await sleep(300);
    return "/demo/brand-logo.png"; // 浏览器预览:返回假路径让 UI 流程可走通
  },
  async selectAudio() {
    await sleep(300);
    return "/demo/bgm.mp3"; // 浏览器预览:返回假路径让 UI 流程可走通
  },
  // AI 配乐:浏览器预览模拟生成延迟后返回假路径(真实生成走 Atlas 云端)
  async generateBgm() {
    await sleep(1800);
    return "/demo/ai-bgm-auto-mock.mp3";
  },
  // 浏览器预览拿不到本地帧——画面速览退化为不展示
  async contactSheet() {
    return "";
  },
  // 浏览器预览没有主进程可以代发请求——给一份演示清单,让选模型的 UI 走得通
  async listLlmModels() {
    await sleep(400);
    return { ids: ["deepseek-v4-flash", "deepseek-v4-pro", "qwen-plus", "glm-4.7"], error: null };
  },
  // 浏览器预览没有本地偏好档——记录静默丢弃
  async recordReview() {},
  async getAudioPeaks(_filePath, startSec, endSec) {
    await sleep(250);
    const hopSec = 1 / 30;
    const n = Math.max(0, Math.floor((endSec - startSec) / hopSec));
    // 确定性伪波形:说话/停顿交替的包络,让浏览器预览看得出时间轴长什么样
    const values = Array.from({ length: n }, (_, i) => {
      const t = startSec + i * hopSec;
      const talking = (Math.sin(t * 0.9) + 1) / 2 > 0.25 ? 1 : 0.1;
      const syllable = 0.3 + 0.7 * Math.abs(Math.sin(t * 7.3) * Math.sin(t * 2.1));
      return Math.min(1, talking * syllable);
    });
    return { values, startSec, hopSec };
  },
  // 浏览器预览:确定性伪曲线——几处高斯峰叠底噪,时间轴的样子完整可看
  async timelineData(_filePath, durationSec) {
    await sleep(400);
    const bins = Math.min(720, Math.max(120, Math.round(durationSec / 5)));
    const peakAt = [0.14, 0.3, 0.42, 0.55, 0.68, 0.86];
    const curve = (amp: number[], noise: number, width: number): number[] =>
      Array.from({ length: bins }, (_, i) => {
        const x = i / bins;
        let v = 0;
        for (let p = 0; p < peakAt.length; p++) v += amp[p % amp.length] * Math.exp(-((x - peakAt[p]) ** 2) / (2 * width * width));
        v += noise * Math.abs(Math.sin(i * 12.9898) * 43758.5453 % 1);
        return Math.min(1, v);
      });
    return {
      loudness: curve([0.7, 0.5, 0.6, 0.4, 0.65, 0.55], 0.18, 0.03),
      danmaku: curve([0.95, 0.7, 0.4, 0.55, 0.6, 0.8], 0.06, 0.018),
      thumbs: [],
      binSec: durationSec / bins,
    };
  },
  async selectDir() {
    await sleep(300);
    return "/demo/录播文件夹";
  },
  async defaultOutDir() {
    return "/Movies/HotClip";
  },
  // 浏览器预览没有真模型目录:给一份形态真实的清点结果,设置页照样能看
  async modelsInfo() {
    await sleep(200);
    const root = "/Library/Application Support/hotclip/models";
    const demo = [
      ["sensevoice-2024-07-17", "useAsrFast", true, 940_000_000, 1_047_870_769],
      ["paraformer-zh-2023-09-14", "useAsrAccurate", false, 0, 251_658_240],
      ["fireredasr-aed-l", "useAsrDialect", false, 0, 545_259_520],
      ["punct-zh-en", "usePunct", true, 41_900_000, 44_040_192],
      ["segmentation-pyannote", "useDiarize", false, 0, 6_291_456],
      ["speaker-embedding-3dspeaker", "useDiarize", false, 0, 41_943_040],
      ["yunet-face", "useFace", true, 227_000, 236_544],
      ["emotion-ferplus", "useEmotion", false, 0, 35_651_584],
      ["transnetv2-onnx", "useShots", true, 31_250_929, 31_250_929],
    ] as const;
    const entries = demo.map(([id, useKey, installed, bytes, approxBytes]) => ({ id, useKey, installed, bytes, approxBytes }));
    return { root, defaultRoot: root, totalBytes: entries.reduce((a, e) => a + e.bytes, 0), entries };
  },
  async moveModelsDir(dir) {
    await sleep(500);
    return dir;
  },
  openFolder() {
    /* browser mock: no file manager to open */
  },
  async watchStart(dir) {
    watchRunning = true;
    watchDirDemo = dir;
    // 演示剧本:一条新录播被发现 → 转写 → 找爆点 → 出片完成
    const file = "直播回放-2026-07-10.flv";
    const path = `${dir}/${file}`;
    const script: Array<[Omit<WatchEvent, "at">, number]> = [
      [{ type: "found", file, path }, 1200],
      [{ type: "transcribing", file, path }, 2600],
      [{ type: "detecting", file, path }, 5200],
      [{ type: "exporting", file, path }, 7400],
      [{ type: "done", file, path, clips: 4, outDir: `${dir}/直播回放-2026-07-10-hotclip` }, 9600],
    ];
    for (const [e, delay] of script) setTimeout(() => emitWatch(e), delay);
  },
  async watchStop() {
    watchRunning = false;
    watchDirDemo = null;
  },
  async watchStatus() {
    return { running: watchRunning, dir: watchDirDemo };
  },
  // 浏览器预览起不了真的 HTTP 端点,复用同一套演示剧本(UI 流程能完整走通)
  async webhookStart(dir, llm, outDir, port) {
    await this.watchStart(dir, llm, outDir);
    webhookPortDemo = port ?? 17650;
    return { port: webhookPortDemo, dir };
  },
  async webhookStop() {
    watchRunning = false;
    watchDirDemo = null;
    webhookPortDemo = null;
  },
  async webhookStatus() {
    return { running: watchRunning && webhookPortDemo !== null, port: webhookPortDemo, dir: watchDirDemo };
  },
  onWatchEvent(cb) {
    watchListeners.add(cb);
    return () => watchListeners.delete(cb);
  },
  async checkUpdate() {
    return null; // 浏览器预览不做更新提示
  },
  async glossaryGet() {
    await sleep(80);
    return mockGlossaryLoad();
  },
  async glossarySet(entries) {
    localStorage.setItem(GLOSSARY_LS_KEY, JSON.stringify(sanitizeGlossary(entries)));
  },
  openUrl(url) {
    window.open(url, "_blank", "noreferrer");
  },
  async detectHighlights(transcript, _llm, _filePath, diarize, prefilter, vision, _length, products, referencePath, _genre, _brief, scan): Promise<DetectHighlightsResult> {
    await sleep(1500);
    // 浏览器预览:给了参考视频就演示一份画像
    const reference = referencePath
      ? { durationSec: 42, speechRate: 5.2, avgSentenceLen: 14, cutsPerMin: 18, hookLine: "你敢信这是同一个人剪的?", zh: true }
      : undefined;
    // 浏览器预览:开了本地初筛就演示一份漏斗统计
    const funnel = prefilter
      ? { totalSegments: 220, keptSegments: 41, totalChars: 12800, keptChars: 2400 }
      : undefined;
    // 开了视觉信号就演示一份抽帧统计;开了全场扫描给扫描档的量级
    const visionStats = vision
      ? scan
        ? { framesTotal: 240, framesScored: 233, peakCount: 9, fullScan: true, notedMoments: 14 }
        : { framesTotal: 20, framesScored: 18, peakCount: 3 }
      : undefined;
    // 表情峰值信号零配置自动跑,浏览器预览恒给演示统计
    const emotionStats = { framesTotal: 96, facesScored: 74, peakCount: 2 };
    // 弹幕信号:演示"录播旁发现了同名弹幕 XML"的情况
    const danmakuStats = { count: 4213, peakCount: 5 };
    // 语气信号:复用本地转写权重,零配置自动跑,浏览器预览恒给演示统计
    const voiceStats = { windowsPlanned: 100, windowsScored: 96, emotionPeakCount: 3, eventPeakCount: 2 };
    const segs = transcript.segments;
    const pick = (from: number, to: number, id: number, title: string, hook: string, score: number, reason: string): HighlightCandidate => ({
      id,
      startSec: segs[from].startSec,
      endSec: segs[to].endSec,
      text: segs.slice(from, to + 1).map((s) => s.text).join(" "),
      title,
      hook,
      score,
      reason,
      boundary: id === 2 ? "anchored" : "exact",
      keywords: id === 2 ? ["十几块", "区别"] : ["吸水速度", "半杯水"],
      scoreDims:
        id === 1
          ? { hook: 91, flow: 84, value: 88, trend: 72 }
          : id === 2
            ? { hook: 78, flow: 80, value: 74, trend: 66 }
            : { hook: 22, flow: 60, value: 30, trend: 40 },
      dimNotes:
        id === 1
          ? { hook: "实测演示开场,3秒内有画面冲击", flow: "起于提问收于结论,完整", value: "省钱结论直接可用", trend: "比价内容平台长青" }
          : undefined,
      teaser: id === 1 ? "倒半杯水会怎样?" : id === 2 ? "差价10倍的真相" : "",
      // 实用密度演示:比价内容(数字密)标「可收藏」
      utility: id === 2 ? { score: 5, hits: ["十几块", "两块多"] } : undefined,
      recommended: id === 1,
      reviewNote: id === 3 ? "开场是问候语,前3秒没有钩子,独立可看性弱" : id === 2 ? "结尾截在逗号上,建议人工顺一下切点" : "",
      // 质量门三档演示:1=建议发 2=需人审(规则层抓到硬伤) 3=弃
      gate: id === 1 ? "publish" : id === 2 ? "review" : "drop",
      gateNotes:
        id === 2
          ? ["结尾没收住(截在逗号上)"]
          : id === 3
            ? ["开场是问候语,单独看没有信息量,不值得发布"]
            : undefined,
    });
    // 多片段拼接演示:承诺句和后面的打脸句相隔很远,摆在一起才成立——
    // 浏览器预览要能走通拼接的整条 UI(候选卡的拼接标记 + 审阅台的段清单预览)
    const stitched: HighlightCandidate = {
      id: 4,
      startSec: segs[1].startSec,
      endSec: segs[5].endSec,
      pieces: [
        { startSec: segs[1].startSec, endSec: segs[1].endSec },
        { startSec: segs[5].startSec, endSec: segs[5].endSec },
      ],
      text: `${segs[1].text} …… ${segs[5].text}`,
      title: "刚说闭眼入,转头就要你下单",
      hook: "今天给大家带来一款超级好用的纸巾,三层加厚,湿水不破",
      score: 88,
      reason: "前后对照,冲突型钩子停留力最强",
      boundary: "anchored",
      keywords: ["湿水不破", "小黄车"],
      scoreDims: { hook: 86, flow: 70, value: 80, trend: 84 },
      dimNotes: {
        hook: "承诺句开场,立刻立起对照",
        flow: "拼接片,已核对两段各自完整、没有断章取义",
        value: "对照本身就是信息",
        trend: "打脸型内容平台长期吃香",
      },
      teaser: "他自己打了自己的脸",
      recommended: true,
      reviewNote: "",
      gate: "publish",
    };
    const candidates = [
      pick(3, 4, 1, "半杯水都不渗?实测给你看", "你看这个吸水速度,直接倒半杯水都不带渗的", 92, "强演示钩子+价格反差,完播率高"),
      pick(1, 2, 2, "十几块和两块多的纸巾差在哪", "很多朋友问我,这个和超市里十几块的有什么区别", 81, "悬念提问开场,击中比价心理"),
      stitched,
      pick(0, 1, 3, "欢迎来到直播间", "大家好,欢迎来到我的直播间", 38, "开场白"),
    ];
    // 商品讲解模式:与主进程同款——命中的商品词确定性并入候选 keywords
    if (products && products.length > 0) {
      for (const c of candidates) {
        const hits = products.filter((p) => p.trim() && c.text.toLowerCase().includes(p.trim().toLowerCase()));
        const seen = new Set(c.keywords.map((k) => k.toLowerCase()));
        c.keywords = [...c.keywords, ...hits.filter((h) => !seen.has(h.toLowerCase()))];
      }
    }
    // Multi-speaker demo: label the transcript by alternating segments so the
    // browser preview can show per-speaker caption coloring end-to-end.
    if (diarize) {
      const labeled: Transcript = {
        ...transcript,
        segments: segs.map((s, i) => ({
          ...s,
          speaker: i % 2,
          words: (s.words ?? []).map((w) => ({ ...w, speaker: i % 2 })),
        })),
      };
      return { candidates, transcript: labeled, funnel, vision: visionStats, emotion: emotionStats, danmaku: danmakuStats, voice: voiceStats, reference };
    }
    return { candidates, funnel, vision: visionStats, emotion: emotionStats, danmaku: danmakuStats, voice: voiceStats, reference };
  },
};

/** True when running inside Electron with the preload bridge available. */
export function isElectron(): boolean {
  return typeof window !== "undefined" && "hotclip" in window && window.hotclip !== undefined;
}

export function getApi(): HotClipApi {
  if (isElectron()) {
    return window.hotclip as HotClipApi;
  }
  return browserMock;
}
