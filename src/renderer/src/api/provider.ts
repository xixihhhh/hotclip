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
} from "../../../shared/api-types";

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
    return mockTranscript();
  },
  onTranscribeProgress(cb) {
    progressListeners.add(cb);
    return () => progressListeners.delete(cb);
  },
  async exportClips(_filePath, clips) {
    const results = [];
    for (let i = 0; i < clips.length; i++) {
      emitExport({ current: i + 1, total: clips.length, clipId: clips[i].id, stage: "cutting" });
      await sleep(1100);
      emitExport({ current: i + 1, total: clips.length, clipId: clips[i].id, stage: "done" });
      results.push({
        id: clips[i].id,
        title: clips[i].title,
        path: `/Movies/HotClip/我的直播回放-2026-07-04/0${i + 1}-${clips[i].title}.mp4`,
        sizeBytes: 8_400_000 + i * 1_700_000,
        durationSec: clips[i].endSec - clips[i].startSec,
      });
    }
    return results;
  },
  onExportProgress(cb) {
    exportListeners.add(cb);
    return () => exportListeners.delete(cb);
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
  async detectHighlights(transcript, _llm, _filePath, diarize, prefilter, vision): Promise<DetectHighlightsResult> {
    await sleep(1500);
    // 浏览器预览:开了本地初筛就演示一份漏斗统计
    const funnel = prefilter
      ? { totalSegments: 220, keptSegments: 41, totalChars: 12800, keptChars: 2400 }
      : undefined;
    // 开了视觉信号就演示一份抽帧统计
    const visionStats = vision ? { framesTotal: 20, framesScored: 18, peakCount: 3 } : undefined;
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
      return { candidates, transcript: labeled, funnel, vision: visionStats };
    }
    return { candidates, funnel, vision: visionStats };
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
