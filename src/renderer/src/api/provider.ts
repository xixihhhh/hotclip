/**
 * API provider: resolves the active HotClipApi implementation.
 *
 * - Inside Electron the preload script exposes `window.hotclip` (IPC-backed).
 * - In a plain browser (design preview today, web platform later) we fall back
 *   to a mock so the full UI stays renderable and testable without Electron.
 */
import type { HotClipApi, MediaInfo } from "../../../shared/api-types";

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

/** Browser-mode mock: deterministic fake data with realistic latency. */
const browserMock: HotClipApi = {
  async selectMedia() {
    await new Promise((r) => setTimeout(r, 300));
    return "/demo/我的直播回放-2026-07-04.mp4";
  },
  async probeMedia() {
    await new Promise((r) => setTimeout(r, 600));
    return { ...MOCK_MEDIA };
  },
};

/** True when running inside Electron with the preload bridge available. */
export function isElectron(): boolean {
  return typeof window !== "undefined" && "hotclip" in window;
}

export function getApi(): HotClipApi {
  if (isElectron()) {
    return (window as unknown as { hotclip: HotClipApi }).hotclip;
  }
  return browserMock;
}
