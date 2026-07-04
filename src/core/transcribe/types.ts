/**
 * Engine-side transcription types. The wire-visible data model (Transcript,
 * words, segments, progress events) lives in shared/api-types so the UI and
 * every platform adapter speak the same shape; this file re-exports it and
 * adds engine-only contracts.
 */
export type {
  Transcript,
  TranscriptSegment,
  TranscriptWord,
  TranscribeStage,
  TranscribeProgressEvent as TranscribeProgress,
} from "../../shared/api-types";
import type { Transcript, TranscribeProgressEvent } from "../../shared/api-types";

export interface TranscribeOptions {
  /** Preferred language hint ("auto" lets the engine detect). */
  language?: string;
  onProgress?: (p: TranscribeProgressEvent) => void;
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
