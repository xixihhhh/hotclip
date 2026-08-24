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
  /** 本句被热词词表自动修正过(逐句稿/审阅台打标记用)。 */
  glossaryApplied?: boolean;
}

/** 热词词表词条:ASR 惯性错词 → 正确写法(人名/品牌/术语)。 */
export interface GlossaryEntry {
  wrong: string;
  right: string;
}

export interface Transcript {
  /** Primary language detected/used, e.g. "zh", "en". */
  language: string;
  segments: TranscriptSegment[];
  /** Engine id that produced this (e.g. "sensevoice-local"). */
  engine: string;
  durationSec: number;
}

export type TranscribeStage =
  | "preparing"
  | "downloading-model"
  | "extracting-model"
  | "decoding"
  | "transcribing"
  | "finalizing";

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

/** 用户点题(v0.13):自然语言告诉 AI 本场重点找什么/明确不要什么。 */
export interface DetectBrief {
  /** 重点找:「只要讲到售后的部分」「重点找他聊创业失败的段落」。 */
  focus?: string;
  /** 明确排除:「不要抽奖和念弹幕」「排除开头暖场」。 */
  exclude?: string;
}

/** 两级漏斗第一级:本地小模型端点(Ollama 等 OpenAI 兼容接口,通常免 Key)。 */
export interface PrefilterConfig {
  baseUrl: string;
  model: string;
  /** 云端端点的 API Key(本地 Ollama 缺省)。 */
  apiKey?: string;
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
  /** 本轮跑的是全场扫描档(v0.13;快扫档缺省)。 */
  fullScan?: boolean;
  /** 全场扫描带出画面描述的时刻数(画面时刻线进了选段证据)。 */
  notedMoments?: number;
  /** 候选段画面复核:复核条数(v0.12;未跑复核缺省)。 */
  candidatesReviewed?: number;
  /** 候选段画面复核:被加分/降分的条数。 */
  candidatesAdjusted?: number;
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

/** 语音情绪/音频事件信号统计(SenseVoice 短窗重扫;UI 展示"听了几窗、圈出几段")。 */
export interface VoiceTagStats {
  windowsPlanned: number;
  windowsScored: number;
  emotionPeakCount: number;
  eventPeakCount: number;
}

/** LLM 端点当前提供的模型清单(GET /models 的结果;失败时 ids 为空、error 有原因)。 */
export interface ModelListResult {
  ids: string[];
  error: string | null;
}

/** 多片段拼接里的一段源片区间(绝对源片时间);详见 core/pieces.ts。 */
export interface ClipPiece {
  startSec: number;
  endSec: number;
}

/** One AI-nominated clip candidate with frame-accurate boundaries. */
export interface HighlightCandidate {
  id: number;
  /** 跨度起点:多段拼接时 = 第一段的起点。 */
  startSec: number;
  /** 跨度终点:多段拼接时 = 最后一段的终点(≠ 成片时长)。 */
  endSec: number;
  /**
   * 多片段拼接的段清单(按时间序)。缺省或只有 1 段 = 普通连续切片。
   * 成片时长是各段之和,不是 endSec-startSec —— 一律用 clipDurationSec() 取。
   */
  pieces?: ClipPiece[];
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
  /**
   * How boundaries were located (match quality signal for the UI).
   * "signal" = 这条不是按原话切的,时间来自视听信号融合(跳舞/萌宠/户外这类
   * 文字稿没内容的品类只能这么来;见 core/highlight/moments.ts)。
   */
  boundary: "exact" | "anchored" | "segment" | "signal";
  /** 信号候选命中的证据种类(boundary="signal" 才有);UI 与回执展示证据链。 */
  signalEvidence?: string[];
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
  /**
   * 质量门三档(v0.13):publish=建议发 / review=有硬伤需人工确认 / drop=不建议发。
   * 缺省 = 没过质量门(信号候选/复评失败/老数据),UI 按普通候选对待。
   */
  gate?: "publish" | "review" | "drop";
  /** 质量门原因清单(LLM 复评 + 规则层硬伤,给人看的证据链)。 */
  gateNotes?: string[];
  /** 实用密度(v0.14 第十路):达线即「值得收藏」,发布文案转收藏/搜索导向。 */
  utility?: { score: number; hits: string[] };
  /** 用户手动调过切点(审阅台/微调按钮):导出时跳过镜头吸附,尊重人的决定。 */
  manualBounds?: boolean;
}

/** 审阅反馈回流:一条被审阅候选的最小特征(本地偏好档;够 LLM 认出"同类"即可)。 */
export interface ReviewedCandidate {
  title: string;
  hook: string;
  score: number;
  /** 片长(秒,取整)——时长偏好也是偏好。 */
  durationSec: number;
  keywords?: string[];
}

/** 一条平台发布结果;只含内容表现,不含账号凭据或本地目录。 */
export interface PerformanceEntry {
  id?: string;
  title: string;
  hook?: string;
  platform: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  durationSec?: number;
  keywords?: string[];
  publishedAt?: string;
  importedAt: string;
}

export interface PerformanceImportResult {
  imported: number;
  skipped: number;
  total: number;
}

/** 设置中心展示的数据摘要;赢家/弱项使用同一套本地质量分排序。 */
export interface PerformanceSummary {
  total: number;
  platforms: string[];
  winners: PerformanceEntry[];
  laggards: PerformanceEntry[];
}

/** Burned-in caption style choices (none = no captions; bubble = web-rendered). */
export type CaptionStyleChoice = "none" | "karaoke" | "keyword" | "pop" | "hormozi" | "minimal" | "bubble";

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

/**
 * 导出画质档 → x264 CRF。数值越小越清晰、文件越大;
 * high 保持历史默认(18),换档只影响体积与清晰度,不改变任何剪辑决策。
 */
export type ExportQuality = "high" | "standard" | "compact";

export const QUALITY_CRF: Record<ExportQuality, number> = {
  high: 18,
  standard: 23,
  compact: 28,
};

/** Render options for the export step (UI toggles on the highlight list). */
export interface ExportOptions {
  /** Center-crop reframe to 9:16 vertical (1080×1920) — short-video ready. */
  vertical: boolean;
  /** Caption style to burn into the picture. */
  captionStyle: CaptionStyleChoice;
  /** Splice out intra-clip silences for a tighter, hand-edited rhythm. */
  jumpCut: boolean;
  /** 保留呼吸口:跳剪剪长停顿时每个剪口多留一口气(~0.25s),不无缝贴死。 */
  keepBreath?: boolean;
  /** 说话人标签:多说话人切片换人时字幕行首加彩色「A:」(开了多人对谈才有标注)。 */
  speakerLabels?: boolean;
  /** 模板受控微扰:按切片种子小幅抖动字幕几何,批量出片不共享模板指纹。 */
  templateJitter?: boolean;
  /** Splice out hesitation sounds (嗯/呃/um/uh) and stutter repeats. */
  cleanFillers?: boolean;
  /** 剪掉重录废稿:同一句紧挨着说了两遍时只留最后一遍。 */
  cutRetakes?: boolean;
  /** 自动运镜:竖屏成片叠一层缓慢推拉镜头,固定机位不再死板。 */
  autoZoom?: boolean;
  /** 音效打点:whoosh 卡拼接缝/ding 卡情绪峰/pop 卡开场钩子,每条 ≤3 个。 */
  sfx?: boolean;
  /** BGM 文件路径:循环铺满全片、对人声闪避混入;空/缺省 = 不加。 */
  bgmPath?: string;
  /** 直播品类 id(genre.ts):导出侧用于跳剪静音阈值分档。 */
  genreId?: string;
  /** 精准切点:候选段用 Paraformer 二遍对齐修正词级时间戳(首次需下载 ~240MB 模型)。 */
  preciseAlign?: boolean;
  /** Auto-crop static screen-recording chrome (status bar, app UI, letterbox). */
  trimUi: boolean;
  /** Burn each clip's title into the top safe zone. */
  titleCard: boolean;
  /** Burn the AI teaser (悬念句) as a big opening hook over the first seconds. */
  openingHook?: boolean;
  /** Match audio to the -14 LUFS social loudness target (EBU R128). */
  normalizeLoudness?: boolean;
  /** 基础降噪:压直播回放常见底噪/电流声(高通×2+afftdn,先于响度标准化)。 */
  denoise?: boolean;
  /** 精华合集:切片按时间序流复制拼成一支合集,附章节时间戳文本。 */
  compilation?: boolean;
  /** 高潮前置:钩子句剪成迷你片拼到切片开头再接完整正片(cold-open)。 */
  coldOpen?: boolean;
  /** 爆点闪现:情绪峰值的 0.3-1s 画面闪到开头再切回(视觉钩子版高潮前置)。 */
  flashForward?: boolean;
  /** 多画幅:竖屏之外再出一版横屏原画幅(竖版发抖音,横版发B站/YouTube)。 */
  alsoLandscape?: boolean;
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
  /** 剪映草稿:每条切片一个草稿文件夹,拷进剪映草稿目录即可打开精修。 */
  jianyingDraft?: boolean;
  /** AI 封面双档:volume=Seedream 走量 / premium=Nano Banana Pro 精品;需 Atlas 档 Key。 */
  aiCover?: { tier: "volume" | "premium"; llm: LlmConfig };
  /** AIGC 标识:画面显式标识 + 元数据隐式标识(发布平台要求 AIGC 声明时开启)。 */
  aigcLabel?: boolean;
  /** 留证包:每条切片流复制源片前后各 3 分钟(授权审核的原始录屏留存)。 */
  evidencePack?: boolean;
  /** 平台发布包:选中的平台 id 清单(platform-specs.ts);每平台落一个齐套文件夹。 */
  publishPack?: string[];
  /** 一片多版:同一切片出 count 版差异化包装(含原版,2 或 3);需要 LLM。 */
  variants?: { count: number; llm: LlmConfig };
  /** 成片导出根目录(成片仍落其下的 <片名>/ 子目录);空/缺省 = 系统默认 ~/影片/HotClip。 */
  outDir?: string;
  /** 导出画质档;缺省 high——与历史默认(CRF 18)一致,升级不改变成片。 */
  quality?: ExportQuality;
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
  /** 语音情绪/音频事件信号生效时的统计;未装本地转写模型时缺省。 */
  voice?: VoiceTagStats;
  /** 参考爆款画像(传了 referencePath 且分析成功才有)。 */
  reference?: ReferenceInfo | null;
  /** 参考视频分析失败原因(fail-open 按无参考继续,但失败必须让用户看见)。 */
  referenceError?: string;
}

/** 参考爆款画像(桌面端「参考爆款」入口;与 core/reference 的 ReferenceProfile 同构)。 */
export interface ReferenceInfo {
  durationSec: number;
  /** 语速:中文按字/秒,英文按词/秒。 */
  speechRate: number;
  avgSentenceLen: number;
  /** 镜头切换频率(次/分钟);检测失败或纯音频为 null。 */
  cutsPerMin: number | null;
  hookLine: string;
  zh: boolean;
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

/**
 * 工作台时间轴数据:全场响度/弹幕热度曲线(每格 0..1)+ 缩略图胶片带。
 * 曲线画在时间轴上,「为什么选这段」从一段文字变成一眼可见的峰。
 * 各路 fail-open:没有的信号给空数组,时间轴照常渲染其余部分。
 */
export interface TimelineData {
  /** 每格一个值(0..1);空数组 = 无此信号。 */
  loudness: number[];
  danmaku: number[];
  /** 均匀抽帧的 JPEG base64(无 data: 前缀);空串格 = 该帧抽取失败。 */
  thumbs: string[];
  /** 曲线每格对应的秒数。 */
  binSec: number;
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
  /** 当前切片的编码进度 0-1(ffmpeg 实时回报);切片间事件缺省。 */
  fraction?: number;
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
    length?: ClipLength,
    /** 商品讲解模式:商品词列表(带货直播按商品选段,命中词并入候选 keywords)。 */
    products?: string[],
    /** 对标爆款视频路径:实测其节奏画像,选段向对标节奏靠拢(偏好不是硬约束)。 */
    referencePath?: string | null,
    /** 直播品类判据:内置预设 id + 用户改写的自定义文本(自定义优先)。 */
    genre?: { id?: string; custom?: string } | null,
    /** 用户点题:重点找什么/明确排除什么(自然语言,注入选段判据)。 */
    brief?: DetectBrief | null,
    /** 全场画面扫描:视觉端点已配置时按 ~30s 一帧扫完整场,画面时刻线进选段证据(费时/云端计费,默认关)。 */
    scan?: boolean
  ) => Promise<DetectHighlightsResult>;
  /** Cut the selected highlights into mp4 files; resolves with the file list. */
  exportClips: (filePath: string, clips: HighlightCandidate[], options?: ExportOptions) => Promise<ExportedClip[]>;
  /** Subscribe to per-clip export progress; returns an unsubscribe function. */
  onExportProgress: (cb: (p: ExportProgressEvent) => void) => () => void;
  /** 取消进行中的导出(会中断正在跑的 ffmpeg;已完成的切片保留)。 */
  cancelExport: () => void;
  /** Reveal an exported file in Finder / Explorer. */
  revealClip: (path: string) => void;
  /** 本地媒体的可播放 URL(审阅台 <video> 用);空串 = 当前环境不支持预览。 */
  mediaUrl: (filePath: string) => string;
  /** 选择一张图片(水印 logo 用);取消返回 null。 */
  selectImage: () => Promise<string | null>;
  /** 选择一个音频文件(BGM 用);取消返回 null。 */
  selectAudio: () => Promise<string | null>;
  /** AI 生成一段版权安全 BGM(按品类风格,需 Atlas 档 Key);返回保存路径。 */
  generateBgm: (config: LlmConfig, genreId?: string) => Promise<string>;
  /** 取 [startSec, endSec] 的音频峰值轨——审阅台时间轴的波形。 */
  getAudioPeaks: (filePath: string, startSec: number, endSec: number) => Promise<AudioPeaks>;
  /** 工作台时间轴数据:全场响度/弹幕热度曲线 + 缩略图胶片带(各路 fail-open)。 */
  timelineData: (filePath: string, durationSec: number) => Promise<TimelineData>;
  /** 候选片段的 3×3 接触表(画面速览):返回 data URL;失败/不支持返回空串。 */
  contactSheet: (filePath: string, startSec: number, endSec: number) => Promise<string>;
  /** 问 LLM 端点要它当前真正提供的模型清单(GET /models);失败返回原因不抛。 */
  listLlmModels: (baseUrl: string, apiKey: string) => Promise<ModelListResult>;
  /** 审阅反馈回流:导出时记录本场采用/否决的候选(本地偏好档,下次检测注入)。 */
  recordReview: (video: string, kept: ReviewedCandidate[], rejected: ReviewedCandidate[]) => Promise<void>;
  /** 真实发布表现摘要(本地 performance-memory.json)。 */
  performanceGet: () => Promise<PerformanceSummary>;
  /** 选择并导入平台 CSV/JSON;用户取消返回 null。 */
  performanceImport: () => Promise<PerformanceImportResult | null>;
  /** 清空真实发布表现记忆;不影响主观审阅偏好。 */
  performanceClear: () => Promise<void>;
  /** 选择一个文件夹(录播监听用);取消返回 null。 */
  selectDir: () => Promise<string | null>;
  /** 出厂导出根目录(~/影片/HotClip),用户没自选时界面显示的就是它。 */
  defaultOutDir: () => Promise<string>;
  /** 模型清点:存放位置、各模型装没装、各占多大(设置页展示)。 */
  modelsInfo: () => Promise<ModelsInfo>;
  /** 把模型目录整体搬到新位置;返回生效后的路径。失败时原目录不受影响。 */
  moveModelsDir: (dir: string) => Promise<string>;
  /** 在系统文件管理器里打开一个目录。 */
  openFolder: (path: string) => void;
  /** 开始监听文件夹:新录播写完落稳后自动全托管切片。 */
  watchStart: (dir: string, llm: LlmConfig, outDir?: string) => Promise<void>;
  watchStop: () => Promise<void>;
  watchStatus: () => Promise<{ running: boolean; dir: string | null }>;
  /**
   * 起录播 webhook 端点(录播姬/blrec 下播回调即出片)。只绑 127.0.0.1;
   * 回调里的文件路径必须落在 dir 之下。返回实际监听端口。
   */
  webhookStart: (
    dir: string,
    llm: LlmConfig,
    outDir?: string,
    port?: number,
    token?: string
  ) => Promise<{ port: number; dir: string }>;
  webhookStop: () => Promise<void>;
  webhookStatus: () => Promise<{ running: boolean; port: number | null; dir: string | null }>;
  /** 订阅监听过程事件;返回退订函数。 */
  onWatchEvent: (cb: (e: WatchEvent) => void) => () => void;
  /** 查一次新版本;断网/失败返回 null(fail-open,绝不打扰)。 */
  checkUpdate: () => Promise<UpdateInfo | null>;
  /** 打开外部链接(仅白名单域,当前只放行本项目 GitHub)。 */
  openUrl: (url: string) => void;
  /** 读热词词表(持久化在本地,转写后自动应用)。 */
  glossaryGet: () => Promise<GlossaryEntry[]>;
  /** 整表写回热词词表(增删改统一走这里)。 */
  glossarySet: (entries: GlossaryEntry[]) => Promise<void>;
}

/** 模型清点结果(设置页「模型存放位置」)。 */
export interface ModelsInfo {
  /** 当前生效的模型根目录。 */
  root: string;
  /** 出厂位置——用户改过后据此提供「恢复默认」。 */
  defaultRoot: string;
  /** 已装模型合计占用字节。 */
  totalBytes: number;
  entries: Array<{
    id: string;
    /** 用途文案的 i18n key。 */
    useKey: string;
    installed: boolean;
    bytes: number;
    approxBytes: number;
  }>;
}

/** 新版本检查结果。 */
export interface UpdateInfo {
  current: string;
  latest: string;
  hasUpdate: boolean;
  url: string;
}
