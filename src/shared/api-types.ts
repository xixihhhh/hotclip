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

/** One timed token/word (zh engines emit per-character tokens — same shape). */
export interface TranscriptWord {
  text: string;
  startSec: number;
  endSec: number;
}

/** A sentence-ish unit built from words; the granularity shown in the editor. */
export interface TranscriptSegment {
  id: number;
  startSec: number;
  endSec: number;
  text: string;
  words: TranscriptWord[];
}

export interface Transcript {
  /** Primary language detected/used, e.g. "zh", "en". */
  language: string;
  segments: TranscriptSegment[];
  /** Engine id that produced this (e.g. "sensevoice-local"). */
  engine: string;
  durationSec: number;
}

export type TranscribeStage = "preparing" | "downloading-model" | "decoding" | "transcribing" | "finalizing";

export interface TranscribeProgressEvent {
  /** 0..1 fraction of the current stage's work. */
  fraction: number;
  stage: TranscribeStage;
  downloadedBytes?: number;
  totalBytes?: number;
}

export interface HotClipApi {
  /** Open a file picker; resolves to a path/handle or null when cancelled. */
  selectMedia: () => Promise<string | null>;
  /** Probe a media file (duration/streams/fps); throws on unreadable input. */
  probeMedia: (filePath: string) => Promise<MediaInfo>;
  /** Transcribe a media file with the current engine (local SenseVoice for now). */
  transcribeMedia: (filePath: string) => Promise<Transcript>;
  /** Subscribe to transcription progress; returns an unsubscribe function. */
  onTranscribeProgress: (cb: (p: TranscribeProgressEvent) => void) => () => void;
}
