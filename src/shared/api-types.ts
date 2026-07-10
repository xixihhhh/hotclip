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

/** 切片时长档:不同平台/账号定位的节奏(短=快节奏竖屏,长=B站/播客金句段)。 */
export type ClipLength = "short" | "standard" | "long";

/** 两级漏斗第一级:本地小模型端点(Ollama 等 OpenAI 兼容接口,通常免 Key)。 */
export interface PrefilterConfig {
  baseUrl: string;
  model: string;
}

/** 漏斗省了多少:全文 vs 入围云端的部分(UI 展示与审计)。 */
export interface FunnelStats {
  totalSegments: number;
  keptSegments: number;
  totalChars: number;
  keptChars: number;
}

/** 视觉爆点信号的抽帧统计(UI 展示"看了多少帧、圈出几段")。 */
export interface VisionStats {
  framesTotal: number;
  framesScored: number;
  peakCount: number;
}

/** 表情峰值信号统计(零配置自动跑;UI 展示"看了几张脸、圈出几段")。 */
export interface EmotionStats {
  framesTotal: number;
  facesScored: number;
  peakCount: number;
}

/** 弹幕热度信号统计(自动发现同名 .xml;UI 展示"读了几条、圈出几段")。 */
export interface DanmakuStats {
  count: number;
  peakCount: number;
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
  /** 用户手动调过切点(审阅台/微调按钮):导出时跳过镜头吸附,尊重人的决定。 */
  manualBounds?: boolean;
}

/** Burned-in caption style choices (none = no captions; bubble = web-rendered). */
export type CaptionStyleChoice = "none" | "karaoke" | "keyword" | "pop" | "bubble";

/** 水印配置:PNG 烧进画面一角。 */
export interface BrandWatermark {
  /** 图片绝对路径(建议透明底 PNG)。 */
  path: string;
  corner: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  /** 不透明度 0..1。 */
  opacity: number;
}

/**
 * 品牌样式预设:一次配置,每条切片复用——竞品把这个锁在付费墙后。
 * 全部可选;缺省字段走内置默认,输出与未配置时逐字节一致。
 */
export interface BrandStyle {
  /** 主高亮色 "#RRGGBB":卡拉OK点亮/关键词强调/开场钩子/气泡渐变同源。 */
  highlightColor?: string;
  /** 字号缩放(三档 0.85/1/1.18,自由数值也接受)。 */
  fontScale?: number;
  /** 字幕高低位置(安全区内三档)。 */
  captionPosition?: "low" | "standard" | "high";
  /** logo 水印;不设则不烧。 */
  watermark?: BrandWatermark;
}

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
  /** 品牌样式预设(高亮色/字号/位置/水印);缺省走内置默认。 */
  brand?: BrandStyle;
  /** 双语字幕:整句译文烧成主字幕下方的小号翻译轨;翻译失败静默跳过。 */
  translate?: { targetLang: string; llm: LlmConfig };
  /** 发布文案:每条切片生成标题+话题+简介,落 .post.txt 与 clips.json;失败静默跳过。 */
  publishCopy?: { llm: LlmConfig };
  /** 每条切片旁落同名 .srt 字幕文件(平台字幕上传/二次精修;双语时含译文行)。 */
  subtitleFile?: boolean;
  /** 输出目录落 timeline.edl——AI 切点交给 DaVinci/Premiere 重链源片精修。 */
  timeline?: boolean;
  /** AIGC 标识:画面显式标识 + 元数据隐式标识(发布平台要求 AIGC 声明时开启)。 */
  aigcLabel?: boolean;
  /** Needed for captions/jump-cut: source of word-level timestamps. */
  transcript?: Transcript;
}

/** UI 选出的渲染开关(ExportOptions 去掉 transcript 的可序列化子集)。 */
export type RenderToggles = Omit<ExportOptions, "transcript">;

/**
 * Detection result: the ranked candidates, plus the diarization-labeled
 * transcript when multi-speaker attribution ran — so the export path can
 * carry per-word speaker ids through to caption coloring.
 */
export interface DetectHighlightsResult {
  candidates: HighlightCandidate[];
  /** Present only when diarization labeled the transcript this run. */
  transcript?: Transcript;
  /** 本地初筛生效时的漏斗统计;未启用/回退全文时缺省。 */
  funnel?: FunnelStats;
  /** 视觉爆点信号生效时的抽帧统计;未启用/回退时缺省。 */
  vision?: VisionStats;
  /** 表情峰值信号生效时的统计;无人脸/模型不可用时缺省。 */
  emotion?: EmotionStats;
  /** 弹幕热度信号生效时的统计;视频旁没有同名弹幕 .xml 时缺省。 */
  danmaku?: DanmakuStats;
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

/** 审阅台时间轴的波形数据:每块的峰值振幅(0..1)。 */
export interface AudioPeaks {
  values: number[];
  /** 首块对应的源片绝对时间。 */
  startSec: number;
  /** 每块的秒数。 */
  hopSec: number;
}

/** 录播监听的过程事件(渲染层控制面板展示)。 */
export interface WatchEvent {
  type: "found" | "transcribing" | "detecting" | "exporting" | "done" | "error";
  /** 文件名(展示用)。 */
  file: string;
  path: string;
  /** done:导出条数。 */
  clips?: number;
  outDir?: string;
  /** error:一句话原因。 */
  message?: string;
  at: number;
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
  detectHighlights: (
    transcript: Transcript,
    llm: LlmConfig,
    filePath?: string,
    diarize?: boolean,
    prefilter?: PrefilterConfig | null,
    vision?: PrefilterConfig | null,
    length?: ClipLength
  ) => Promise<DetectHighlightsResult>;
  /** Cut the selected highlights into mp4 files; resolves with the file list. */
  exportClips: (filePath: string, clips: HighlightCandidate[], options?: ExportOptions) => Promise<ExportedClip[]>;
  /** Subscribe to per-clip export progress; returns an unsubscribe function. */
  onExportProgress: (cb: (p: ExportProgressEvent) => void) => () => void;
  /** Reveal an exported file in Finder / Explorer. */
  revealClip: (path: string) => void;
  /** 本地媒体的可播放 URL(审阅台 <video> 用);空串 = 当前环境不支持预览。 */
  mediaUrl: (filePath: string) => string;
  /** 选择一张图片(水印 logo 用);取消返回 null。 */
  selectImage: () => Promise<string | null>;
  /** 取 [startSec, endSec] 的音频峰值轨——审阅台时间轴的波形。 */
  getAudioPeaks: (filePath: string, startSec: number, endSec: number) => Promise<AudioPeaks>;
  /** 选择一个文件夹(录播监听用);取消返回 null。 */
  selectDir: () => Promise<string | null>;
  /** 开始监听文件夹:新录播写完落稳后自动全托管切片。 */
  watchStart: (dir: string, llm: LlmConfig) => Promise<void>;
  watchStop: () => Promise<void>;
  watchStatus: () => Promise<{ running: boolean; dir: string | null }>;
  /** 订阅监听过程事件;返回退订函数。 */
  onWatchEvent: (cb: (e: WatchEvent) => void) => () => void;
}
