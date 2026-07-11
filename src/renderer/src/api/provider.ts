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
  async selectDir() {
    await sleep(300);
    return "/demo/录播文件夹";
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
  async detectHighlights(transcript, _llm, _filePath, diarize, prefilter, vision, _length): Promise<DetectHighlightsResult> {
    await sleep(1500);
    // 浏览器预览:开了本地初筛就演示一份漏斗统计
    const funnel = prefilter
      ? { totalSegments: 220, keptSegments: 41, totalChars: 12800, keptChars: 2400 }
      : undefined;
    // 开了视觉信号就演示一份抽帧统计
    const visionStats = vision ? { framesTotal: 20, framesScored: 18, peakCount: 3 } : undefined;
    // 表情峰值信号零配置自动跑,浏览器预览恒给演示统计
    const emotionStats = { framesTotal: 96, facesScored: 74, peakCount: 2 };
    // 弹幕信号:演示"录播旁发现了同名弹幕 XML"的情况
    const danmakuStats = { count: 4213, peakCount: 5 };
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
      recommended: id !== 3,
      reviewNote: id === 3 ? "开场是问候语,前3秒没有钩子,独立可看性弱" : "",
    });
    const candidates = [
      pick(3, 4, 1, "半杯水都不渗?实测给你看", "你看这个吸水速度,直接倒半杯水都不带渗的", 92, "强演示钩子+价格反差,完播率高"),
      pick(1, 2, 2, "十几块和两块多的纸巾差在哪", "很多朋友问我,这个和超市里十几块的有什么区别", 81, "悬念提问开场,击中比价心理"),
      pick(0, 1, 3, "欢迎来到直播间", "大家好,欢迎来到我的直播间", 38, "开场白"),
    ];
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
      return { candidates, transcript: labeled, funnel, vision: visionStats, emotion: emotionStats, danmaku: danmakuStats };
    }
    return { candidates, funnel, vision: visionStats, emotion: emotionStats, danmaku: danmakuStats };
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
