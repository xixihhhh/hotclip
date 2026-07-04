/**
 * Transcript data model — the foundation the whole pipeline stands on.
 * Highlight detection reverse-matches LLM-selected TEXT onto word/token
 * timestamps, so every engine MUST emit token-level timing, not just segments.
 */

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
  /** BCP-47-ish primary language detected/used, e.g. "zh", "en". */
  language: string;
  segments: TranscriptSegment[];
  /** Engine id that produced this (e.g. "sensevoice-local", "atlas-seed-asr"). */
  engine: string;
  /** Total audio duration in seconds (for progress/coverage checks). */
  durationSec: number;
}

export interface TranscribeProgress {
  /** 0..1 fraction of audio processed. */
  fraction: number;
  /** Current pipeline stage for the UI. */
  stage: "preparing" | "downloading-model" | "decoding" | "transcribing" | "finalizing";
  /** Optional bytes progress while downloading a model. */
  downloadedBytes?: number;
  totalBytes?: number;
}

export interface TranscribeOptions {
  /** Preferred language hint ("auto" lets the engine detect). */
  language?: string;
  onProgress?: (p: TranscribeProgress) => void;
  /** Abort long runs (user pressed cancel). */
  signal?: AbortSignal;
}

/** Every transcription backend (local or cloud) implements this. */
export interface TranscribeEngine {
  id: string;
  /** Human label for the settings UI. */
  label: string;
  /** True when the engine can run right now (binary/model/key present). */
  isReady(): Promise<boolean>;
  /** Transcribe a local media file (any container ffmpeg can read). */
  transcribe(filePath: string, options?: TranscribeOptions): Promise<Transcript>;
}
