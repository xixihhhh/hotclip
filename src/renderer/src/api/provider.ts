/**
 * API provider: resolves the active HotClipApi implementation.
 *
 * - Inside Electron the preload script exposes `window.hotclip` (IPC-backed).
 * - In a plain browser (design preview today, web platform later) we fall back
 *   to a mock so the full UI stays renderable and testable without Electron.
 */
import type { HotClipApi, MediaInfo, Transcript, TranscribeProgressEvent } from "../../../shared/api-types";

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
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Browser-mode mock: deterministic fake data with realistic staged latency. */
const browserMock: HotClipApi = {
  async selectMedia() {
    await sleep(300);
    return "/demo/我的直播回放-2026-07-04.mp4";
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
