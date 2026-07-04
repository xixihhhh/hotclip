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

/** LLM connection settings (OpenAI-compatible endpoint; Atlas Cloud preset default). */
export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** One AI-nominated clip candidate with frame-accurate boundaries. */
export interface HighlightCandidate {
  id: number;
  startSec: number;
  endSec: number;
  /** Verbatim transcript text covered by the clip. */
  text: string;
  /** Suggested post title (transcript language). */
  title: string;
  /** The opening hook line the clip leads with. */
  hook: string;
  /** Virality ranking score 0-100 — a RANKER, not a truth claim. */
  score: number;
  /** One-line reason ("why this clip") — the evidence chain seed. */
  reason: string;
  /** How boundaries were located (match quality signal for the UI). */
  boundary: "exact" | "anchored" | "segment";
}

/** One exported clip file on disk. */
export interface ExportedClip {
  id: number;
  title: string;
  path: string;
  sizeBytes: number;
  durationSec: number;
}

export interface ExportProgressEvent {
  /** 1-based index of the clip currently being cut. */
  current: number;
  total: number;
  clipId: number;
  stage: "cutting" | "done";
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
  /** Detect highlight candidates from a finished transcript via the configured LLM. */
  detectHighlights: (transcript: Transcript, llm: LlmConfig) => Promise<HighlightCandidate[]>;
  /** Cut the selected highlights into mp4 files; resolves with the file list. */
  exportClips: (filePath: string, clips: HighlightCandidate[]) => Promise<ExportedClip[]>;
  /** Subscribe to per-clip export progress; returns an unsubscribe function. */
  onExportProgress: (cb: (p: ExportProgressEvent) => void) => () => void;
  /** Reveal an exported file in Finder / Explorer. */
  revealClip: (path: string) => void;
}
