/**
 * The platform-agnostic API contract between the UI and the pipeline backend.
 *
 * The renderer depends ONLY on this interface — never on Electron directly.
 * Implementations:
 *  - Electron: preload bridges these calls over IPC to src/main (current).
 *  - Browser dev / future web platform: an HTTP or mock implementation
 *    (see renderer/src/api/provider.ts). This seam is what makes a future
 *    web deployment a new adapter, not a rewrite.
 */

/** Normalized description of an imported media file. */
export interface MediaInfo {
  durationSec: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width: number;
  height: number;
  fps: number;
  bitRate: number;
  videoCodec: string;
  audioCodec: string;
}

export interface HotClipApi {
  /** Open a file picker; resolves to a path/handle or null when cancelled. */
  selectMedia: () => Promise<string | null>;
  /** Probe a media file (duration/streams/fps); throws on unreadable input. */
  probeMedia: (filePath: string) => Promise<MediaInfo>;
}
