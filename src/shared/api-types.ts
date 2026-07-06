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
  /** Diarization speaker id (0-based); absent when diarization didn't run. */
  speaker?: number;
}

/** A sentence-ish unit built from words; the granularity shown in the editor. */
export interface TranscriptSegment {
  id: number;
  startSec: number;
  endSec: number;
  text: string;
  words: TranscriptWord[];
  /** Dominant diarization speaker id (0-based); absent when not diarized. */
  speaker?: number;
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

/** Catalog facts + runtime state for one transcription engine choice. */
export interface AsrEngineInfo {
  id: string;
  kind: "local" | "cloud";
  langs: string[];
  sizeMB?: number;
  speed: 1 | 2 | 3;
  accuracy: 1 | 2 | 3;
  uploads: boolean;
  /** Local model already on disk (no download needed). */
  installed: boolean;
}

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
  /** Verbatim in-clip keywords (caption emphasis); may be empty. */
  keywords: string[];
  /** Four-dimension virality breakdown (0-100 each) from the stage-2 reviewer. */
  scoreDims?: { hook: number; flow: number; value: number; trend: number };
  /** One-line reviewer reason per dimension; may be empty strings. */
  dimNotes?: { hook: string; flow: string; value: string; trend: string };
  /** Short suspense line (≤15 chars) usable as an on-video text hook. */
  teaser?: string;
  /** Stage-2 review verdict: false = the AI reviewer advises against publishing. */
  recommended: boolean;
  /** One-line reviewer note (why weak / why strong); may be empty. */
  reviewNote: string;
}

/** Burned-in caption style choices (none = no captions; bubble = web-rendered). */
export type CaptionStyleChoice = "none" | "karaoke" | "keyword" | "pop" | "bubble";

/** Render options for the export step (UI toggles on the highlight list). */
export interface ExportOptions {
  /** Center-crop reframe to 9:16 vertical (1080×1920) — short-video ready. */
  vertical: boolean;
  /** Caption style to burn into the picture. */
  captionStyle: CaptionStyleChoice;
  /** Splice out intra-clip silences for a tighter, hand-edited rhythm. */
  jumpCut: boolean;
  /** Splice out hesitation sounds (嗯/呃/um/uh) and stutter repeats. */
  cleanFillers?: boolean;
  /** Auto-crop static screen-recording chrome (status bar, app UI, letterbox). */
  trimUi: boolean;
  /** Burn each clip's title into the top safe zone. */
  titleCard: boolean;
  /** Burn the AI teaser (悬念句) as a big opening hook over the first seconds. */
  openingHook?: boolean;
  /** Match audio to the -14 LUFS social loudness target (EBU R128). */
  normalizeLoudness?: boolean;
  /** Needed for captions/jump-cut: source of word-level timestamps. */
  transcript?: Transcript;
}

/**
 * Detection result: the ranked candidates, plus the diarization-labeled
 * transcript when multi-speaker attribution ran — so the export path can
 * carry per-word speaker ids through to caption coloring.
 */
export interface DetectHighlightsResult {
  candidates: HighlightCandidate[];
  /** Present only when diarization labeled the transcript this run. */
  transcript?: Transcript;
}

/** One exported clip file on disk. */
export interface ExportedClip {
  id: number;
  title: string;
  path: string;
  /** Cover JPG exported next to the clip (may be absent on failure). */
  coverPath?: string;
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
  /** List selectable transcription engines with install state. */
  listAsrEngines: () => Promise<AsrEngineInfo[]>;
  /** Transcribe with the chosen engine; cloud engines need the user's API key. */
  transcribeMedia: (filePath: string, engineId?: string, apiKey?: string) => Promise<Transcript>;
  /** Subscribe to transcription progress; returns an unsubscribe function. */
  onTranscribeProgress: (cb: (p: TranscribeProgressEvent) => void) => () => void;
  /** Detect highlight candidates via the configured LLM; filePath enables audiovisual-signal evidence. */
  detectHighlights: (transcript: Transcript, llm: LlmConfig, filePath?: string, diarize?: boolean) => Promise<DetectHighlightsResult>;
  /** Cut the selected highlights into mp4 files; resolves with the file list. */
  exportClips: (filePath: string, clips: HighlightCandidate[], options?: ExportOptions) => Promise<ExportedClip[]>;
  /** Subscribe to per-clip export progress; returns an unsubscribe function. */
  onExportProgress: (cb: (p: ExportProgressEvent) => void) => () => void;
  /** Reveal an exported file in Finder / Explorer. */
  revealClip: (path: string) => void;
}
