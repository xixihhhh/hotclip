/**
 * Clip export orchestrator: cut every selected highlight out of the source
 * video into ready-to-post mp4s. Pure helpers (naming) + one effectful runner.
 * Optional render passes: 9:16 vertical reframe and burned-in karaoke captions.
 */
import { mkdir, stat, writeFile, rm, mkdtemp, rename } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { tmpdir } from "os";
import { join, basename } from "path";
import { resolveFfmpegPath } from "./binaries";

const execFileAsync = promisify(execFile);
import { cutClip, cutJumpClip, concatClips, type CutOptions } from "./cut";
import { planColdOpen, planFlashForward, FLASH_SKIP_NEAR_START_SEC } from "./coldopen";
import { computeJumpCut, BREATH_PAD_SEC } from "./gaps";
import { perturbLayout } from "../shared/perturb";
import { clampTranslationLines, remapTranslationLines, type TranslationLine } from "./translate";
import { postTextFile, type PublishCopy } from "./publish";
import { buildPublishPacks, coverFilter, type PackSummary } from "./publish-pack";
import { buildSeriesPack, type SeriesPackSummary } from "./series-pack";
import { buildSrt, srtLinesFromWords } from "./srt";
import { buildEdl, type EdlClip } from "./edl";
import { buildDraftContent, buildDraftMetaInfo } from "./jianying";
import { generateAiCover, type CoverTier } from "./cover-ai";
import { runAudiogram, audiogramSpec } from "./audiogram";
import { pickCoverTime } from "./cover";
import { proposeCoverTimes, selectQualityCoverTime, type CoverSelectionReceipt } from "./cover-quality";
import { findFillerWords, dropFillerWords, fillerCutSpans, type FillerHit } from "./fillers";
import { findRetakes, dropRetakeWords, retakeCutSpans, type RetakeHit } from "./retakes";
import {
  mergePieces,
  normalizePieces,
  pieceCutSpans,
  piecesDurationSec,
  planFromPieces,
  withinOnePiece,
  type ClipPiece,
} from "../shared/pieces";
import { extractPeaks, findPeakEvents } from "./audio-peaks";
import { genrePauseGapSec } from "./genre";
import {
  planSfxCues,
  ensureSfxAssets,
  applySoundDesign,
  hasSoundDesignWork,
  type SfxCue,
} from "./sound-design";
import { detectUiCrop, type UiCrop } from "./uicrop";
import { generateCropPlan, renderCropXExpr, mapToOutputTime, remapCropKeyframes } from "./reframe";
import type { AnalysisVideoOptions } from "./analysis-video";
import { snapClipToShots, SNAP_MAX_OUT_SEC } from "./shots";
import { collectSignalsEvidence, detectShotBoundariesEvidence, detectSpeechActivityEvidence } from "./media-evidence";
import {
  assessSpeechActivity,
  normalizeSpeechSpans,
  refineSpeechBoundaries,
  speechActivityRangeSupported,
  type SpeechActivitySpan,
} from "./speech-activity";
import { buildCaptionAss, VERTICAL_LAYOUT, HORIZONTAL_LAYOUT, type CaptionStyle } from "./subtitle";
import { lintSubtitleTimeline } from "./subtitle-quality";
import { buildOverlayPayload, isWebCaptionStyle, type OverlayRenderFn, type WebCaptionStyle } from "./caption-overlay/payload";
import { probeMedia } from "./probe";
import { runClipQa, maxVisualGapSec, missingHookPayoffs, summarizeSubjectCoverage, type ClipQaReport } from "./qa";
import { lintClipContent } from "./content-lint";
import { mapSensitiveRanges } from "./sensitive-words";
import { planRepair, applyRepair } from "./repair";
import { applyBrandToLayout } from "./brand";
import type { AlignmentQualityReport, SubtitleQualityReport, TranscriptWord, BrandStyle } from "../shared/api-types";
import type { WatermarkSpec } from "./cut";
import { transformScore, type TransformInputs, type TransformScore } from "../shared/transform-score";
import { buildLedgerCsv, type LedgerRow } from "./ledger";
import { resolveVideoEncoder } from "./video-encoder";
import {
  createRenderCacheKey,
  fingerprintRenderFile,
  hashRenderInput,
  invalidateRenderCache,
  restoreRenderCache,
  storeRenderCache,
  type FileFingerprint,
} from "./render-cache";
import { canCopyVideoStream, probeVideoKeyframes } from "./smart-render";
import { planVisualEnhancement, type VisualEnhancePlan, type VisualSignalSample } from "./visual-enhance";
import { isExecutableColorPlan, isHdrSource, planColorRender, type ColorRenderPlan } from "./color";
import {
  applySmartDenoiseWithFallback,
  type AudioEnhancementReceipt,
  type DenoiseMode,
} from "./speech-enhancement";
import { DPDFNET_SPEECH_ENHANCEMENT_MODEL } from "./models";

export interface ExportClipSpec {
  id: number;
  title: string;
  startSec: number;
  endSec: number;
  /**
   * 多片段拼接的段清单(按时间序;≥2 段才生效)。给了它就用它,startSec/endSec
   * 退化为跨度首尾——段间空隙走跳剪机器剪掉,字幕/译文/封面/EDL 自动对齐。
   */
  pieces?: ClipPiece[];
  /** Words the clip covers (absolute source time) — needed for caption burn-in. */
  words?: TranscriptWord[];
  /** Verbatim keywords to emphasize (keyword caption style). */
  keywords?: string[];
  /** 片外紧邻词的时刻(全量转写里算好传入)——镜头吸附外扩的守卫。 */
  snapContext?: { prevWordEndSec: number | null; nextWordStartSec: number | null };
  /** 用户在审阅台手动定过切点:跳过镜头吸附,机器不再改人的决定。 */
  manualBounds?: boolean;
  /** 双语字幕的整句译文行(源片绝对时间,主进程预先翻译好传入)。 */
  translation?: TranslationLine[];
  /** 发布文案(主进程预先生成传入),落 .post.txt 并进 clips.json。 */
  publish?: PublishCopy;
  /** 一片多版:本条是哪条原版的变体(原版 spec 的 id);原版缺省。 */
  variantOf?: number;
  /** 版本序号(原版是 1,变体从 2 起);原版缺省。 */
  variant?: number;
  /** 封面抓第几高的响度峰(0=最高,与历史一致);变体封面靠它错开帧。 */
  coverRank?: number;
  /**
   * 一片多版的结构差异维度:本条强制开「爆点闪现」开场(与全局开关 OR)。
   * 变体不只换包装——最后一版连开场结构都不同,矩阵分发的「真差异」再进一步;
   * 闪不出来(全程无显著峰)按既有 fail-open 回退普通开场。
   */
  flashForward?: boolean;
  /** Evidence-chain fields carried into clips.json for CMS/matrix pipelines. */
  meta?: {
    hook: string;
    score: number;
    reason: string;
    text: string;
    recommended: boolean;
    reviewNote: string;
    visualEvidence?: {
      score: number;
      scene: string;
      match: boolean;
      visibleText?: string[];
    };
    scoreDims?: { hook: number; flow: number; value: number; trend: number };
    teaser?: string;
  };
}

/** How long the opening hook (teaser) stays on screen — the 黄金3秒 window. */
const OPENING_HOOK_SEC = 2.2;

/**
 * 抽峰值轨的最大跨度。拼接片的跨度可能横跨几十分钟(「前后打脸」的两段本来
 * 就隔得远),整段解码抽峰值又慢又没用——超过这个跨度就不抽,跳剪的静音门
 * 和智能封面各自按既有 fail-open 路径退化(与"提取失败"完全同一条分支)。
 */
export const PEAK_SPAN_MAX_SEC = 300;

function peakSpanTooLong(clip: { startSec: number; endSec: number }): boolean {
  return clip.endSec - clip.startSec > PEAK_SPAN_MAX_SEC;
}

/**
 * 拼接片的人脸取景:逐段检测再把关键帧平移到「相对切片起点」的同一时间基,
 * 裁窗尺寸取第一段成功的那版(同一源片,各段算出来必然一致)。
 * 全部失败返回 null → 上游回退中心裁,与单段路径同一语义。
 */
async function cropPlanOverPieces(
  inputPath: string,
  pieces: ClipPiece[],
  clipStartSec: number,
  modelsRoot: string,
  uiCrop?: UiCrop,
  analysis?: AnalysisVideoOptions
): Promise<Awaited<ReturnType<typeof generateCropPlan>>> {
  let merged: Awaited<ReturnType<typeof generateCropPlan>> = null;
  for (const p of pieces) {
    const cp = await generateCropPlan(inputPath, p.startSec, p.endSec, modelsRoot, uiCrop, analysis).catch(() => null);
    if (!cp) continue;
    const shift = p.startSec - clipStartSec;
    const kfs = cp.keyframes.map((k) => ({ ...k, t: k.t + shift }));
    const coverageSamples = cp.coverageSamples.map((sample) => ({ ...sample, t: sample.t + shift }));
    if (!merged) merged = { ...cp, keyframes: kfs, coverageSamples };
    else {
      merged.keyframes.push(...kfs);
      merged.coverageSamples.push(...coverageSamples);
      merged.composition.totalShots += cp.composition.totalShots;
      merged.composition.lockedShots += cp.composition.lockedShots;
      merged.composition.groupLockedShots += cp.composition.groupLockedShots;
      merged.composition.trackedShots += cp.composition.trackedShots;
      merged.composition.recoveryShots += cp.composition.recoveryShots;
      merged.composition.centeredShots += cp.composition.centeredShots;
    }
  }
  return merged;
}

/**
 * Summarize a jump-cut/filler splice plan into the clips.json `edit` block.
 * Pure so the numbers (removed seconds, cut ratio) are unit-testable without
 * running ffmpeg. Returns null when nothing was spliced.
 */
export function summarizeEdit(
  origDurSec: number,
  plan: { segments: unknown[]; durationSec: number } | null
): ClipRenderOutcome["edit"] {
  if (!plan || origDurSec <= 0) return null;
  return {
    splices: plan.segments.length,
    keptSec: Number(plan.durationSec.toFixed(2)),
    removedSec: Number(Math.max(0, origDurSec - plan.durationSec).toFixed(2)),
    cutRatio: Number(Math.max(0, 1 - plan.durationSec / origDurSec).toFixed(3)),
  };
}

/**
 * 变形度输入(v0.14,纯函数):从单条回执 + 导出选项映射出各变形项——
 * 尽量用「实际发生了什么」(outcome)而非「开关开没开」(options),
 * 回退失败的项不能骗分。
 */
export function transformInputsFromRender(
  render: ClipRenderOutcome,
  opts: Pick<ExportRenderOptions, "titleCard" | "autoZoom" | "brand">
): TransformInputs {
  return {
    vertical: render.reframe === "face-track" || render.reframe === "center-crop",
    captions: render.captionsBurned,
    recut: (render.edit?.splices ?? 0) > 0 || render.fillersRemoved > 0 || render.retakesRemoved > 0,
    reopened: render.coldOpenSec !== null || render.flashForward,
    titleOverlay: Boolean(opts.titleCard) || render.openingHookBurned,
    autoZoom: Boolean(opts.autoZoom),
    bgm: render.bgmMixed,
    sfx: render.sfxCues > 0,
    stitched: render.stitchedPieces >= 2,
    translated: render.translatedLines > 0,
    watermark: Boolean(opts.brand?.watermark),
  };
}

/** What the pipeline actually did to one clip — surfaced in clips.json. */
export interface ClipRenderOutcome {
  /** Effective caption style burned in ("none" when captions were skipped). */
  captionStyle: string;
  /** False when a web-overlay pass failed and the clip shipped without word captions. */
  captionsBurned: boolean;
  /** "face-track" when the crop followed a face, "center-crop" on fallback, "none" for horizontal, "audiogram" for audio-only sources. */
  reframe: "face-track" | "center-crop" | "none" | "audiogram";
  /** Per-shot comfort-composition receipt when face-aware reframing ran. */
  reframeComposition?: {
    totalShots: number;
    lockedShots: number;
    groupLockedShots: number;
    trackedShots: number;
    recoveryShots: number;
    centeredShots: number;
  };
  /** Jump-cut / filler splice outcome; null when the clip was cut whole. */
  edit: { splices: number; keptSec: number; removedSec: number; cutRatio: number } | null;
  /** Number of filler/stutter words removed. */
  fillersRemoved: number;
  /** 剪掉的重录废稿句数(开了「剪重录」才可能非 0)。 */
  retakesRemoved: number;
  /** 多片段拼接的段数(0 表示这条是一段连续内容)。 */
  stitchedPieces: number;
  /** True when audio was matched to the -14 LUFS social loudness target. */
  loudnessNormalized: boolean;
  /** True when basic or learned audio cleanup was requested. */
  denoised: boolean;
  /** Requested/applied audio cleanup tier; absent on legacy exports. */
  audioEnhancement?: AudioEnhancementReceipt;
  /** Clip-local measured picture correction; null when disabled. */
  visualEnhance?: VisualEnhancePlan | null;
  /** Source color evidence and the exact HDR→SDR decision; absent on legacy exports. */
  color?: ColorRenderPlan | null;
  /** Number of transcript-timed sensitive-language windows muted. */
  sensitiveMutes?: number;
  /** 高潮前置迷你片时长(秒);没开/钩子定位失败/被守卫跳过为 null。 */
  coldOpenSec: number | null;
  /** True 表示前置的迷你片是「爆点闪现」(0.3-1s 画面钩子)而非钩子句。 */
  flashForward: boolean;
  /** True when the AI teaser was burned in as an opening hook. */
  openingHookBurned: boolean;
  /** 实际烧进画面的译文行数;没开双语/翻译失败为 0。 */
  translatedLines: number;
  /** 切点吸附到镜头边界的实际位移(秒);没吸附(或检测失败)为 null。 */
  shotSnap: { startDeltaSec: number; endDeltaSec: number } | null;
  /** Local speech evidence used by automatic edges/jump cuts; absent on legacy exports. */
  speechActivity?: {
    mode: "vad" | "fallback";
    wordCoverage: number;
    spans: number;
    startDeltaSec: number;
    endDeltaSec: number;
    protectedGaps: number;
  };
  /** True 表示词表经 Paraformer 二遍对齐修正过(精准切点)。 */
  preciseAligned: boolean;
  /** Detailed final-candidate alignment receipt; absent on legacy exports, null when alignment did not run or failed open. */
  alignment?: AlignmentQualityReport | null;
  /** Deterministic subtitle lint; issue ranges use the final clip timeline before cold-open duplication. */
  subtitleQuality?: SubtitleQualityReport | null;
  /** 实际打进成片的音效数(0 = 没开/无处可打/混音失败回退)。 */
  sfxCues: number;
  /** True 表示 BGM 混入成功(含人声闪避)。 */
  bgmMixed: boolean;
  /** Base-render cache result for this clip. */
  renderCache?: "hit" | "miss" | "disabled";
  /** How the base video became available; cached keeps the receipt truthful when no encoder ran. */
  videoMode?: "copy" | "encode" | "cached";
  /** Final-render cover-frame selection evidence; absent on legacy exports. */
  coverSelection?: CoverSelectionReceipt;
}

export interface ExportRenderOptions {
  /** Center-crop reframe to 9:16 (1080×1920). */
  vertical?: boolean;
  /** Caption style to burn in (clips must carry `words`); omit for none. */
  captionStyle?: CaptionStyle | WebCaptionStyle;
  /** Injected web-overlay renderer (Electron main); required for web styles. */
  renderOverlay?: OverlayRenderFn;
  /** Splice out intra-clip silences (clips must carry `words`). */
  jumpCut?: boolean;
  /** 保留呼吸口:跳剪剪长停顿时每个剪口多留一口气(~0.25s),不无缝贴死。 */
  keepBreath?: boolean;
  /** 说话人标签:多说话人切片换人时字幕行首加彩色「A:」(词表带标注才生效)。 */
  speakerLabels?: boolean;
  /** 模板受控微扰:按切片种子小幅抖动字幕几何(字号/基线),批量出片不共享模板指纹。 */
  templateJitter?: boolean;
  /** Splice out hesitation sounds (嗯/呃/um/uh) and stutter repeats. */
  cleanFillers?: boolean;
  /** 剪掉重录废稿:同一句紧挨着说了两遍时,只留最后一遍(见 retakes.ts)。 */
  cutRetakes?: boolean;
  /** 自动运镜:竖屏成片叠一层缓慢推拉镜头(见 autozoom.ts)。 */
  autoZoom?: boolean;
  /** 音效打点:whoosh 卡拼接缝/ding 卡情绪峰/pop 卡开场钩子(见 sound-design.ts)。 */
  sfx?: boolean;
  /** BGM 文件路径:循环铺满全片,对人声 sidechain 闪避后混入。 */
  bgmPath?: string;
  /** 直播品类 id(core/genre.ts):决定跳剪静音阈值分档;缺省走默认档。 */
  genreId?: string;
  /**
   * 精准切点(可选注入,见 align.ts createClipAligner):候选段用 Paraformer
   * 二遍解码修正词级时间戳;返回 null 表示对不上(回退原词表)。
   */
  alignWords?: (
    filePath: string,
    clip: { startSec: number; endSec: number; pieces?: ClipPiece[]; words: TranscriptWord[] }
  ) => Promise<{ words: TranscriptWord[]; report: AlignmentQualityReport } | null>;
  /** Auto-detect & crop static screen-recording chrome (status bars, app UI). */
  trimUi?: boolean;
  /** Face-tracking vertical reframe (needs modelsRoot); falls back to center. */
  faceTrack?: boolean;
  /** Where AI models live (userData/models in the app). */
  modelsRoot?: string;
  /** Burn each clip's title into the top safe zone. */
  titleCard?: boolean;
  /** Burn the AI teaser (悬念句) as a big opening hook over the clip's first seconds. */
  openingHook?: boolean;
  /** Bundled-font directory handed to libass so CJK renders identically everywhere. */
  fontsDir?: string;
  /** Match audio to the -14 LUFS social loudness target (EBU R128 loudnorm). */
  normalizeLoudness?: boolean;
  /** 基础降噪:压直播回放常见底噪/电流声(高通×2+afftdn,先于响度标准化)。 */
  denoise?: boolean;
  /** `smart` uses the optional 48 kHz local speech model and falls back to `basic`. */
  denoiseMode?: DenoiseMode;
  /** Conservative clip-local exposure, contrast and saturation correction. */
  autoEnhance?: boolean;
  /** User-controlled terms muted at transcript word timestamps. */
  muteTerms?: string[];
  /** 精华合集:导出的切片按时间序流复制拼成一支合集(≥2 条才生成)。 */
  compilation?: boolean;
  /** 高潮前置:钩子句剪成迷你片拼到切片开头再接完整正片(cold-open)。 */
  coldOpen?: boolean;
  /**
   * 爆点闪现(flash-forward):把全片情绪峰值的 0.3-1s 画面闪现到开头再切回
   * ——视觉钩子版的高潮前置。与 coldOpen 同开时优先闪现,闪不出(全程无
   * 显著峰)回退钩子句前置。
   */
  flashForward?: boolean;
  /** 多画幅:竖屏之外再出一版横屏原画幅(落 `横屏/` 子目录,竖版发抖音横版发B站)。 */
  alsoLandscape?: boolean;
  /** 切点吸附镜头边界(TransNetV2,需 modelsRoot);检测失败静默回退不吸附。 */
  snapToShots?: boolean;
  /** 品牌样式预设(高亮色/字号/位置/水印);缺省走内置默认,输出不变。 */
  brand?: BrandStyle;
  /** x264 CRF(越小越清晰、文件越大);缺省 18——保持历史默认画质不变。 */
  crf?: number;
  /** 双语字幕的目标语言(回执用;译文本身随 ExportClipSpec.translation 传入)。 */
  translateLang?: string;
  /** 每条切片旁落同名 .srt 字幕文件(平台字幕上传/二次精修用)。 */
  subtitleFile?: boolean;
  /** 输出目录落 timeline.edl(CMX3600)——切点交给剪辑软件重链源片精修。 */
  timeline?: boolean;
  /** 剪映草稿:每条切片一个草稿文件夹(拷进剪映草稿目录即可打开精修)。 */
  jianyingDraft?: boolean;
  /**
   * AI 封面双档(v0.14):按切片标题生成竖版大字封面,与抓帧封面并存。
   * volume=Seedream 走量档 / premium=Nano Banana Pro 精品档;需要 LLM 档
   * 指向 Atlas 且带 Key(zh 控制提示词语言);失败静默,绝不拖垮导出。
   */
  aiCover?: { tier: CoverTier; baseUrl: string; apiKey: string; zh?: boolean };
  /** AIGC 标识:左上角「AI 生成」显式标识 + 容器元数据隐式标识(《标识办法》)。 */
  aigcLabel?: boolean;
  /** 留证包(v0.14):每条切片流复制源片前后各 3 分钟到「留证/」——授权审核新规要求的原始录屏留存。 */
  evidencePack?: boolean;
  /** 平台发布包:按平台规格整理齐套素材到 `发布包/<平台>/`(见 publish-pack.ts)。 */
  publishPack?: string[];
  /** 主题系列包:按重复关键词把原版成片整理为有顺序的系列目录。 */
  seriesPack?: boolean;
  /**
   * 出片自我质检(默认开):每条成片渲染后解码扫描黑屏/长静音/响度/时长
   * 偏差,复核切点是否压在词中间,并扫标题/钩子/文案/字幕的平台违禁词;
   * 报告进 clips.json 的 qa 字段。显式 false 关闭(如超长批量赶时间)。
   */
  qa?: boolean;
  /**
   * qa 修复循环(默认随 qa 开):可自愈的告警——首尾静音/黑屏裁边、响度
   * 二遍归一——自动修复后重检,告警变少才替换成片(qa.repair 可审计)。
   * 显式 false 只检不修。
   */
  qaRepair?: boolean;
  /** Shared bounded cache for exact base renders. Omit to disable. */
  renderCacheDir?: string;
  /** Cache budget override; defaults to a conservative 1GiB. */
  renderCacheMaxBytes?: number;
  /** Shared bounded cache for source-derived analysis evidence. Omit to disable. */
  evidenceCacheDir?: string;
}

export interface ExportedClip {
  id: number;
  title: string;
  path: string;
  /** Cover JPG next to the clip (frame from just after the hook). */
  coverPath?: string;
  sizeBytes: number;
  durationSec: number;
  /** True when an explicit PQ/HLG source was safely tone-mapped to SDR BT.709. */
  colorConverted?: boolean;
  /** HDR was detected but its input colour path was incomplete or unsupported. */
  colorConversionSkipped?: boolean;
  /** Source probing failed, so HDR colour safety could not be evaluated. */
  colorInspectionFailed?: boolean;
  /** Effective audio cleanup tier for completion/headless status. */
  audioEnhancement?: AudioEnhancementReceipt["applied"];
  /** 出片质检报告;质检关闭或检测失败为 null/undefined。 */
  qa?: ClipQaReport | null;
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

/** Whitelist-sanitize: keep letters (all scripts incl. CJK), digits, space, dash, underscore. */
export function sanitizeFilename(name: string, fallback = "clip"): string {
  const cleaned = name
    .replace(/[^\p{L}\p{N} \-_]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return cleaned || fallback;
}

/** "01-标题.mp4" — index keeps timeline order even after fs sorting. */
export function clipFilename(index: number, title: string): string {
  return `${String(index).padStart(2, "0")}-${sanitizeFilename(title)}.mp4`;
}

/** 章节时间戳里的时刻:YouTube/B站章节格式(超一小时自动带小时位)。 */
function chapterClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/**
 * 合集的章节时间戳文本(YouTube 章节/B站简介都认这个格式,粘贴即用):
 * 每条切片一行「0:00 标题」,时刻为该条在合集里的起点(累计时长)。
 */
export function buildChapters(items: Array<{ title: string; durationSec: number }>): string {
  let t = 0;
  const lines = items.map((it) => {
    const line = `${chapterClock(t)} ${it.title}`;
    t += it.durationSec;
    return line;
  });
  return lines.join("\n") + "\n";
}

/** Cut all clips sequentially (ffmpeg saturates cores per encode anyway). */
export async function exportClips(
  inputPath: string,
  clips: ExportClipSpec[],
  outDir: string,
  options: ExportRenderOptions = {},
  onProgress?: (p: ExportProgressEvent) => void,
  signal?: AbortSignal
): Promise<ExportedClip[]> {
  await mkdir(outDir, { recursive: true });
  // ASS files live in a throwaway temp dir for the duration of the run.
  const needAss =
    Boolean(options.captionStyle) || Boolean(options.titleCard) || Boolean(options.openingHook) ||
    Boolean(options.aigcLabel) || clips.some((c) => (c.translation?.length ?? 0) > 0);
  const assDir = needAss ? await mkdtemp(join(tmpdir(), "hotclip-ass-")) : null;
  // 音效素材目录:首次要用时才建(mkdtemp + ffmpeg 合成三个 wav,幂等)
  let sfxDir: string | null = null;
  const ensureSfxDir = async (): Promise<string> => {
    if (!sfxDir) sfxDir = await ensureSfxAssets(await mkdtemp(join(tmpdir(), "hotclip-sfx-")), signal);
    return sfxDir;
  };
  // 品牌预设:字号/位置作用于布局,高亮色传给字幕构建,水印挂进 filter 链
  const baseLayout = applyBrandToLayout(options.vertical ? VERTICAL_LAYOUT : HORIZONTAL_LAYOUT, options.brand);
  const watermark: WatermarkSpec | undefined = options.brand?.watermark
    ? {
        path: options.brand.watermark.path,
        corner: options.brand.watermark.corner,
        opacity: options.brand.watermark.opacity,
        // 竖屏输出恒为 1080 宽,logo 占 16%;横屏输出宽度=源宽(未知),用固定 300px
        widthPx: options.vertical ? Math.round(1080 * 0.16) : 300,
      }
    : undefined;

  // 纯音频源(播客/录音)走 audiogram:深色底+品牌色波形自动合成画面,
  // 视频专属阶段(去录屏UI/人脸取景/镜头吸附)整体跳过
  const srcInfo = await probeMedia(inputPath).catch(() => null);
  const sourceStreams = {
    videoStreamIndex: srcInfo?.videoStreamIndex,
    audioStreamIndex: srcInfo?.audioStreamIndex,
  };
  const colorInspectionFailed = srcInfo === null;
  const audioOnly = srcInfo ? !srcInfo.hasVideo : false;
  const color = srcInfo?.hasVideo ? planColorRender(srcInfo) : null;
  const hdrDetected = isHdrSource(color);
  const allowSdrVisualEnhance = !hdrDetected && !colorInspectionFailed;
  // SDR/unknown sources keep their existing pixel treatment. Stream indices
  // are still explicit so multi-track inputs cannot probe one picture and
  // render another; the cache identity below isolates those selections.
  const activeColor = isExecutableColorPlan(color) ? color : undefined;
  const sourceAnalysis: AnalysisVideoOptions = {
    videoStreamIndex: srcInfo?.videoStreamIndex,
    color,
  };
  // One encoder probe per process/run. The cut layer retries libx264 if the
  // advertised hardware encoder is unusable because of a missing device/driver.
  const videoEncoder = audioOnly ? "libx264" as const : await resolveVideoEncoder();
  // Cache identity is resolved once per export. If source/watermark metadata
  // cannot be read, caching simply disables itself and the normal render path
  // continues unchanged.
  let cacheSource: FileFingerprint | null = null;
  let cacheWatermark: FileFingerprint | null = null;
  if (options.renderCacheDir) {
    cacheSource = await fingerprintRenderFile(inputPath).catch(() => null);
    if (watermark) cacheWatermark = await fingerprintRenderFile(watermark.path).catch(() => null);
  }
  const renderCacheReady = Boolean(
    options.renderCacheDir && cacheSource && (!watermark || cacheWatermark)
  );
  let visualSamples: VisualSignalSample[] = [];
  if (options.autoEnhance && !audioOnly && allowSdrVisualEnhance) {
    const signals = await collectSignalsEvidence({
      videoPath: inputPath,
      evidenceDir: options.evidenceCacheDir,
      signal,
      source: cacheSource ?? undefined,
      analysis: sourceAnalysis,
    }).catch((error) => {
      if (signal?.aborted) throw error;
      return null;
    });
    visualSamples = signals?.visualSamples ?? [];
  }

  // 多画幅:开「+横屏版」时进度总数翻倍(第二遍横屏在主循环后递归跑)。
  // 竖屏源裁不出可用的 16:9,原画幅本来就是竖的——直接跳过横屏版。
  const alsoLandscape =
    Boolean(options.alsoLandscape && options.vertical) &&
    (srcInfo && srcInfo.hasVideo ? srcInfo.width >= srcInfo.height : !audioOnly);
  const totalUnits = clips.length * (alsoLandscape ? 2 : 1);

  // one UI-chrome detection pass for the whole source (bands don't move)
  let uiCrop: UiCrop | undefined;
  if (options.trimUi && clips.length > 0 && !audioOnly) {
    const spanEnd = Math.max(...clips.map((c) => c.endSec));
    uiCrop = await detectUiCrop(inputPath, spanEnd, srcInfo?.videoStreamIndex, color).catch(() => undefined);
    if (uiCrop && uiCrop.topFrac === 0 && uiCrop.bottomFrac === 0) uiCrop = undefined;
  }

  try {
    const results: ExportedClip[] = [];
    // "you decide what got cut": removed filler texts surface in clips.json
    const removedFillersByClip = new Map<number, string[]>();
    // Per-clip processing outcomes for clips.json — what the pipeline actually
    // did (and where it fell back), so "fully managed" stays inspectable.
    const renderByClip = new Map<number, ClipRenderOutcome>();
    // 吸附后的实际切点(clips.json 的 sourceStart/End 要报真实值)
    const snappedRange = new Map<number, { startSec: number; endSec: number }>();
    // 规整后的拼接段清单(clips.json 报的是真正剪进去的那几段)
    const piecesByClip = new Map<number, ClipPiece[]>();
    // 时间线导出:每条切片实际保留的源片区间(跳剪时一条多段)
    const edlClips: EdlClip[] = [];
    for (let i = 0; i < clips.length; i++) {
      let clip = clips[i];
      if (signal?.aborted) throw new Error("export cancelled");
      onProgress?.({ current: i + 1, total: totalUnits, clipId: clip.id, stage: "cutting" });

      // 模板受控微扰(v0.14):按「源文件+切片 id」种子小幅抖动字幕几何,
      // 批量出的成片不共享像素级相同的版式指纹;同种子可复现。
      const layout = options.templateJitter
        ? perturbLayout(baseLayout, `${basename(inputPath)}#${clip.id}`)
        : baseLayout;

      // 多片段拼接:段清单在这里定型,后面所有阶段都以它为准。
      // 手动选段(manualBounds)只并重叠不砍段——「最多 4 段/最短 2 秒」是
      // AI 拼接的护栏,用户亲手挑的句子一段都不许悄悄丢
      const pieces = clip.manualBounds ? mergePieces(clip.pieces ?? [], 0) : normalizePieces(clip.pieces ?? []);
      const stitched = pieces.length > 1;
      if (stitched) piecesByClip.set(clip.id, pieces);

      // 精准切点(二遍对齐):必须在镜头吸附/跳剪/字幕之前修好词表——
      // 下游所有阶段都消费 clip.words 的时间。失败/低匹配率回退原词表。
      let preciseAligned = false;
      let alignment: AlignmentQualityReport | null = null;
      if (options.alignWords && clip.words && clip.words.length > 0) {
        const refined = await options
          .alignWords(inputPath, { startSec: clip.startSec, endSec: clip.endSec, pieces: clip.pieces, words: clip.words })
          .catch((e) => {
            if (signal?.aborted) throw e;
            console.error(`precise align failed for clip ${clip.id}, kept original words:`, e);
            return null;
          });
        if (refined && refined.words.length > 0) {
          clip = { ...clip, words: refined.words };
          preciseAligned = true;
          alignment = refined.report;
        }
      }

      // Speech-aware safety layer: the tiny local VAD corroborates ASR before
      // it may refine automatic outer edges or protect a nominally silent gap.
      // Any model/decode/cache failure, suspicious word coverage, long range,
      // manual outer bound, or stitched outer bound preserves historical cuts.
      let speechSpans: SpeechActivitySpan[] | undefined;
      let speechAnchorStart: number | undefined;
      let speechAnchorEnd: number | undefined;
      let speechActivity: ClipRenderOutcome["speechActivity"];
      if (options.jumpCut && options.modelsRoot && clip.words && clip.words.length > 0 && srcInfo?.hasAudio !== false) {
        const speechRanges = stitched
          ? pieces.map((piece) => ({ startSec: piece.startSec, endSec: piece.endSec }))
          : [{ startSec: Math.max(0, clip.startSec - 0.8), endSec: clip.endSec + 0.8 }];
        let detected: SpeechActivitySpan[] | null = null;
        if (speechRanges.length > 0 && speechRanges.every((range) => speechActivityRangeSupported(range.startSec, range.endSec))) {
          detected = [];
          for (const range of speechRanges) {
            const batch = await detectSpeechActivityEvidence({
              mediaPath: inputPath,
              startSec: range.startSec,
              endSec: range.endSec,
              modelsRoot: options.modelsRoot,
              audioStreamIndex: srcInfo?.audioStreamIndex,
              evidenceDir: options.evidenceCacheDir,
              signal,
              source: cacheSource ?? undefined,
            }).catch((error) => {
              if (signal?.aborted) throw error;
              return null;
            });
            if (batch === null) {
              detected = null;
              break;
            }
            detected.push(...batch);
          }
        }
        const normalized = detected ? normalizeSpeechSpans(detected) : [];
        const assessedWords = stitched
          ? clip.words.filter((word) => pieces.some((piece) => word.endSec > piece.startSec && word.startSec < piece.endSec))
          : clip.words;
        const assessment = assessSpeechActivity(normalized, assessedWords);
        speechActivity = {
          mode: assessment.usable ? "vad" : "fallback",
          wordCoverage: Number(assessment.wordCoverage.toFixed(3)),
          spans: normalized.length,
          startDeltaSec: 0,
          endDeltaSec: 0,
          protectedGaps: 0,
        };
        if (assessment.usable) {
          speechSpans = normalized;
          if (!clip.manualBounds && !stitched) {
            const refined = refineSpeechBoundaries(clip.startSec, clip.endSec, clip.words, normalized, clip.snapContext);
            speechAnchorStart = refined.anchorStartSec;
            speechAnchorEnd = refined.anchorEndSec;
            speechActivity.startDeltaSec = Number(refined.startDeltaSec.toFixed(3));
            speechActivity.endDeltaSec = Number(refined.endDeltaSec.toFixed(3));
            if (refined.startSec !== clip.startSec || refined.endSec !== clip.endSec) {
              clip = { ...clip, startSec: refined.startSec, endSec: refined.endSec };
              snappedRange.set(clip.id, { startSec: refined.startSec, endSec: refined.endSec });
            }
          }
        }
      }

      // 切点吸附:起止点吸到最近的镜头边界(词边界守卫,检测失败回退不吸附)。
      // 必须在跳剪/字幕/取景之前调整——下游全部消费 clip.startSec/endSec。
      // 拼接片跳过:内部切点是「意思」定的,吸到镜头边界会把对照关系吸歪。
      let shotSnap: ClipRenderOutcome["shotSnap"] = null;
      if (options.snapToShots && options.modelsRoot && !clip.manualBounds && !audioOnly && !stitched) {
        const pad = SNAP_MAX_OUT_SEC + 0.4;
        const boundaries = await detectShotBoundariesEvidence({
          videoPath: inputPath,
          startSec: clip.startSec - pad,
          endSec: clip.endSec + pad,
          modelsRoot: options.modelsRoot,
          evidenceDir: options.evidenceCacheDir,
          signal,
          source: cacheSource ?? undefined,
          analysis: sourceAnalysis,
        }).catch((error) => {
          if (signal?.aborted) throw error;
          return [] as number[];
        });
        const w = clip.words;
        const snap = snapClipToShots(clip.startSec, clip.endSec, boundaries, {
          firstWordStartSec: speechAnchorStart === undefined
            ? w?.[0]?.startSec
            : Math.min(w?.[0]?.startSec ?? speechAnchorStart, speechAnchorStart),
          lastWordEndSec: speechAnchorEnd === undefined
            ? (w && w.length > 0 ? w[w.length - 1].endSec : undefined)
            : Math.max(w && w.length > 0 ? w[w.length - 1].endSec : speechAnchorEnd, speechAnchorEnd),
          prevWordEndSec: clip.snapContext?.prevWordEndSec,
          nextWordStartSec: clip.snapContext?.nextWordStartSec,
        });
        if (snap.snapped) {
          clip = { ...clip, startSec: snap.startSec, endSec: snap.endSec };
          snappedRange.set(clip.id, { startSec: snap.startSec, endSec: snap.endSec });
          shotSnap = {
            startDeltaSec: Number(snap.startDeltaSec.toFixed(3)),
            endDeltaSec: Number(snap.endDeltaSec.toFixed(3)),
          };
        }
      }

      // Jump cut: plan kept segments + words remapped to the output timeline.
      // Peaks gate the cuts so wordless-but-loud moments (laughter, applause,
      // BGM stings) survive; peak extraction failure degrades to gap-only.
      // Filler cleanup rides the same splice machinery: hesitation sounds and
      // stutters become forced-cut spans (they are audible speech — neither
      // the gap rule nor the silence gate would remove them).
      // 拼接片的段间空隙就是强制剪除区间——拼接完全复用跳剪机器,不另起时间轴
      const stitchSpans = stitched ? pieceCutSpans(pieces) : [];
      let plan = null;
      let fillerHits: FillerHit[] = [];
      let retakeHits: RetakeHit[] = [];
      // 峰值轨提升作用域:跳剪的静音门用,封面选帧也用(见下)
      let clipPeaks: Awaited<ReturnType<typeof extractPeaks>> | undefined;
      if ((options.jumpCut || options.cleanFillers || options.cutRetakes || stitched) && clip.words && clip.words.length > 0) {
        fillerHits = options.cleanFillers ? findFillerWords(clip.words) : [];
        // 重录废稿:在去掉语气词之后判(口误"呃"不该影响两遍话的相似度)
        const deFilled = dropFillerWords(clip.words, fillerHits);
        retakeHits = options.cutRetakes ? findRetakes(deFilled) : [];
        const planWords = dropRetakeWords(deFilled, retakeHits);
        const peaks = options.jumpCut && !peakSpanTooLong(clip)
          ? await extractPeaks(inputPath, clip.startSec, clip.endSec, srcInfo?.audioStreamIndex).catch(() => undefined)
          : undefined;
        clipPeaks = peaks;
        // filler/retake-only mode with nothing found → leave the clip untouched
        if (options.jumpCut || stitched || fillerHits.length > 0 || retakeHits.length > 0) {
          // 情绪守卫:峰值事件(笑声/怒吼/掌声)前后 1s 的停顿是节目效果,禁剪——
          // 抖包袱前的憋是喜剧节奏,机器不该「优化」掉它
          const protectedSpans = peaks
            ? findPeakEvents(peaks).map((e) => ({ startSec: e.startSec - 1.0, endSec: e.endSec + 1.0 }))
            : [];
          plan = computeJumpCut(planWords, clip.startSec, clip.endSec, {
            peaks,
            forceCutSpans: [...stitchSpans, ...fillerCutSpans(fillerHits), ...retakeCutSpans(retakeHits)].sort(
              (a, b) => a.startSec - b.startSec
            ),
            // 静音阈值按品类分档:解说 0.4s、口播 0.6s、对谈 0.9s(genre.ts)
            gapThresholdSec: options.jumpCut ? genrePauseGapSec(options.genreId) : Infinity,
            protectedSpans,
            // 保留呼吸口:每个剪口在句尾多留一口气,不是无缝贴死
            breathPadSec: options.keepBreath ? BREATH_PAD_SEC : 0,
            speechSpans,
          });
          if (speechActivity && speechSpans) speechActivity.protectedGaps = plan.speechProtectedGaps ?? 0;
        }
      }
      // 拼接片但没有词表(不烧字幕也不跳剪):段清单本身就是成片计划
      if (!plan && stitched) {
        plan = planFromPieces(pieces);
      }
      const baseSegments = plan?.segments ?? [{ startSec: clip.startSec, endSec: clip.endSec }];
      // Tier-0 luma thresholds currently describe the encoded signal domain;
      // they are not valid SDR measurements for a PQ/HLG source. Tone mapping
      // therefore owns HDR color conversion and adaptive finishing stays off.
      const visualEnhance = options.autoEnhance && allowSdrVisualEnhance
        ? planVisualEnhancement(visualSamples, baseSegments)
        : null;
      const captionWords = plan ? plan.words : clip.words;
      const captionShift = plan ? 0 : clip.startSec;

      const clipDuration = plan ? plan.durationSec : clip.endSec - clip.startSec;
      let subtitlePath: string | undefined;
      let subtitleHash: string | undefined;
      const wantCaptions = Boolean(options.captionStyle && captionWords && captionWords.length > 0);
      // Web styles render words in the overlay pass; ASS then only draws the
      // title card. ASS styles burn everything in one libass pass as before.
      const webStyle = isWebCaptionStyle(options.captionStyle) && wantCaptions && options.renderOverlay
        ? options.captionStyle
        : undefined;
      const assStyle: CaptionStyle = isWebCaptionStyle(options.captionStyle) ? "keyword" : (options.captionStyle ?? "keyword");
      const subtitleQuality = wantCaptions
        ? lintSubtitleTimeline(captionWords!, layout, assStyle, plan?.breaks, clip.keywords)
        : null;
      // Opening hook: burn the AI teaser (悬念句) big in the upper third for the
      // clip's first seconds — this is what the teaser was generated for.
      const teaser = clip.meta?.teaser?.trim();
      const openingHook = options.openingHook && teaser
        ? { text: teaser, durationSec: Math.min(OPENING_HOOK_SEC, clipDuration) }
        : undefined;
      // 双语译文行:先夹进(吸附后的)最终切片,跳剪时再映射到压缩时间轴。
      // 时间基与 captionWords 保持一致,buildCaptionAss 用同一个 captionShift 平移。
      let transLines = clip.translation && clip.translation.length > 0
        ? clampTranslationLines(clip.translation, clip.startSec, clip.endSec)
        : [];
      if (plan && transLines.length > 0) transLines = remapTranslationLines(transLines, plan.segments);
      if (assDir && needAss && ((wantCaptions && !webStyle) || options.titleCard || openingHook || transLines.length > 0 || options.aigcLabel)) {
        subtitlePath = join(assDir, `clip-${clip.id}.ass`);
        const ass = buildCaptionAss(
          wantCaptions && !webStyle ? captionWords! : [],
          captionShift,
          layout,
          assStyle,
          {
            keywords: clip.keywords,
            forcedBreaks: plan?.breaks,
            titleCard: options.titleCard ? { text: clip.title, durationSec: clipDuration } : undefined,
            openingHook,
            highlightHex: options.brand?.highlightColor,
            translation: transLines.length > 0 ? transLines : undefined,
            aigcBadge: options.aigcLabel ? { durationSec: clipDuration } : undefined,
            speakerLabels: options.speakerLabels,
          }
        );
        subtitleHash = hashRenderInput(ass);
        await writeFile(subtitlePath, ass, "utf8");
      }

      // Face-aware reframe: plan per clip; any failure falls back to center.
      let trackPlan;
      let reframeComposition: ClipRenderOutcome["reframeComposition"];
      let reframeCoverage: ClipQaReport["subjectCoverage"];
      if (options.vertical && options.faceTrack && options.modelsRoot && !audioOnly) {
        // 拼接片逐段各算一版:整段跨度可能有几十分钟,人脸检测按跨度跑纯属白烧。
        // 每段的关键帧相对本段起点,统一平移到「相对切片起点」再走同一条重映射。
        const cp = stitched
          ? await cropPlanOverPieces(inputPath, pieces, clip.startSec, options.modelsRoot, uiCrop, sourceAnalysis)
          : await generateCropPlan(
              inputPath, clip.startSec, clip.endSec, options.modelsRoot, uiCrop, sourceAnalysis
            ).catch(() => null);
        if (cp) {
          let kfs = cp.keyframes;
          let coverageSamples = cp.coverageSamples;
          if (plan) {
            // jump cut: preserve retained motion without interpolating through removed gaps
            kfs = remapCropKeyframes(kfs, plan.segments, clip.startSec);
            coverageSamples = coverageSamples.filter(
              (sample) => mapToOutputTime(sample.t, plan.segments, clip.startSec) !== null
            );
          }
          if (kfs.length > 0) {
            reframeComposition = cp.composition;
            reframeCoverage = summarizeSubjectCoverage(coverageSamples);
            trackPlan = {
              cropXExpr: renderCropXExpr(kfs),
              cropW: cp.cropW,
              cropH: cp.cropH,
              cropY: cp.cropY,
            };
          }
        }
      }

      const outPath = join(outDir, clipFilename(i + 1, clip.title));
      // Web overlay may fail-open to the base clip (no word captions) — record it.
      let webRenderFailed = false;
      // Web captions: cut to a base file first, then composite words on top.
      const cutTarget = webStyle ? outPath.replace(/\.mp4$/, ".base.mp4") : outPath;
      // 切片内实时进度:ffmpeg 已编码秒数 → 当前切片 0-1,节流后随进度事件上报
      let lastPct = -1;
      const onTimeSec = (sec: number): void => {
        const fraction = Math.max(0, Math.min(1, sec / Math.max(0.1, clipDuration)));
        const pct = Math.floor(fraction * 50); // 2% 粒度节流
        if (pct !== lastPct) {
          lastPct = pct;
          onProgress?.({ current: i + 1, total: totalUnits, clipId: clip.id, stage: "cutting", fraction });
        }
      };

      // AIGC 隐式标识:内容属性 + 服务者 + 内容编号写进容器元数据(《标识办法》)
      const aigcMeta = options.aigcLabel
        ? { comment: `AIGC=true; Label=AI-assisted-editing; Tool=HotClip; ContentId=${basename(outPath)}` }
        : undefined;
      // 峰值事件(输出时间轴):运镜强调与音效打点共用一份——响度峰≈情绪
      // 高点,与智能封面同一声学代理;跳剪时映射到压缩时间轴。提取失败/
      // 拼接跨度超限按「无事件」fail-open。
      if ((options.autoZoom || options.sfx || options.flashForward || clip.flashForward) && !clipPeaks && !peakSpanTooLong(clip)) {
        clipPeaks = await extractPeaks(inputPath, clip.startSec, clip.endSec, srcInfo?.audioStreamIndex).catch(() => undefined);
      }
      // (源时间, 输出时间) 成对保留:运镜强调/音效打点吃输出时间,
      // 爆点闪现要回源片切那一刀、吃源时间
      const peakEventPairs = clipPeaks
        ? findPeakEvents(clipPeaks)
            .map((e) => ({
              srcSec: e.atSec,
              outSec: plan ? mapToOutputTime(e.atSec, plan.segments, clip.startSec) : e.atSec - clip.startSec,
            }))
            .filter((p): p is { srcSec: number; outSec: number } => p.outSec !== null && p.outSec >= 0 && p.outSec <= clipDuration)
        : [];
      const peakEventsOut = peakEventPairs.map((p) => p.outSec);
      // 自动运镜:只对竖屏画面有意义(音频波形图和横屏原片不做);
      // 帧率未知就不开——zoompan 会把素材重采样到 25fps。
      // 强调时刻 = 最响的几个峰值事件——「推近必须绑定真实事件」,纯呼吸
      // 之外镜头语言要和内容对上(autozoom.ts 本就支持,这里把信号接通)
      const autoZoom =
        options.autoZoom && options.vertical && !audioOnly && srcInfo && srcInfo.fps > 0
          ? {
              durationSec: clipDuration,
              fps: srcInfo.fps,
              emphasisAtSec: peakEventsOut.slice(0, 4).sort((a, b) => a - b),
            }
          : undefined;
      const sensitiveMuteRanges =
        options.muteTerms && clip.words
          ? mapSensitiveRanges(clip.words, options.muteTerms, plan?.segments ?? [{ startSec: clip.startSec, endSec: clip.endSec }])
          : undefined;
      // Smart cleanup runs once over the fully assembled clip, immediately
      // before SFX/BGM. Defer both denoise and loudness to that post-pass so
      // inference sees the final edit and loudness is measured after it.
      const smartDenoise = Boolean(options.denoise && options.denoiseMode === "smart");
      const baseDenoise = smartDenoise ? false : options.denoise;
      const baseNormalizeLoudness = smartDenoise ? false : options.normalizeLoudness;
      const cutOptions: CutOptions = trackPlan
        ? { ...sourceStreams, trackPlan, autoZoom, visualEnhance, color: activeColor, subtitlePath, fontsDir: subtitlePath ? options.fontsDir : undefined, normalizeLoudness: baseNormalizeLoudness, denoise: baseDenoise, muteRanges: sensitiveMuteRanges, watermark, metadata: aigcMeta, crf: options.crf, encoder: videoEncoder }
        : {
            ...sourceStreams,
            uiCrop,
            vertical: options.vertical,
            autoZoom,
            visualEnhance,
            color: activeColor,
            subtitlePath,
            fontsDir: subtitlePath ? options.fontsDir : undefined,
            normalizeLoudness: baseNormalizeLoudness,
            denoise: baseDenoise,
            muteRanges: sensitiveMuteRanges,
            watermark,
            metadata: aigcMeta,
            crf: options.crf,
            encoder: videoEncoder,
          };
      const baseKind = audioOnly ? "audiogram" : baseSegments.length > 1 ? "jump-cut" : "cut";
      const cacheKey = renderCacheReady
        ? createRenderCacheKey({
            source: cacheSource,
            implementation: "export-base-v1",
            kind: baseKind,
            segments: baseSegments,
            options: {
              uiCrop,
              ...sourceStreams,
              vertical: options.vertical,
              autoZoom,
              visualEnhance,
              color: activeColor,
              trackPlan,
              subtitleSha256: subtitleHash,
              fontsDir: subtitlePath ? options.fontsDir : undefined,
              normalizeLoudness: baseNormalizeLoudness,
              denoise: baseDenoise,
              audioEnhancement: smartDenoise
                ? { requested: "smart", modelId: DPDFNET_SPEECH_ENHANCEMENT_MODEL.id }
                : undefined,
              muteRanges: sensitiveMuteRanges,
              watermark: watermark ? { ...watermark, file: cacheWatermark } : undefined,
              metadata: aigcMeta,
              crf: options.crf,
              encoder: videoEncoder,
              audiogram: audioOnly ? audiogramSpec(Boolean(options.vertical), options.brand?.highlightColor) : undefined,
            },
          })
        : null;
      let renderCache: ClipRenderOutcome["renderCache"] = renderCacheReady ? "miss" : "disabled";
      let videoMode: ClipRenderOutcome["videoMode"] = "encode";
      let cacheHit = false;
      if (cacheKey && options.renderCacheDir) {
        cacheHit = await restoreRenderCache(options.renderCacheDir, cacheKey, cutTarget);
        if (cacheHit) {
          const cachedInfo = await probeMedia(cutTarget).catch(() => null);
          if (!cachedInfo?.hasVideo || cachedInfo.durationSec <= 0) {
            cacheHit = false;
            await invalidateRenderCache(options.renderCacheDir, cacheKey);
            await rm(cutTarget, { force: true }).catch(() => undefined);
          }
        }
      }
      if (cacheHit) {
        renderCache = "hit";
        videoMode = "cached";
        onProgress?.({ current: i + 1, total: totalUnits, clipId: clip.id, stage: "cutting", fraction: 1 });
      } else {
        if (audioOnly) {
          // audiogram:深色底+品牌色波形合成画面,单段/跳剪统一(波形随剪好的音频生成)
          await runAudiogram(
            inputPath,
            cutTarget,
            baseSegments,
            {
              // 与 ASS layout 的竖/横选择严格一致,playRes 才对得上
              spec: audiogramSpec(Boolean(options.vertical), options.brand?.highlightColor),
              subtitlePath,
              fontsDir: subtitlePath ? options.fontsDir : undefined,
              normalizeLoudness: baseNormalizeLoudness,
              denoise: baseDenoise,
              muteRanges: sensitiveMuteRanges,
              watermark,
              metadata: aigcMeta,
              crf: options.crf,
            },
            signal,
            onTimeSec
          );
        } else if (baseSegments.length > 1) {
          await cutJumpClip(inputPath, cutTarget, clip.startSec, baseSegments, cutOptions, signal, onTimeSec);
        } else {
          // Single kept segment: copy H.264 video only when its start is proven
          // keyframe-aligned and no pixel-changing filter is active.
          const range = baseSegments[0];
          // First use a synthetic aligned timestamp to check codec/filter
          // eligibility; only pay for ffprobe when the edit could actually copy.
          const copyCandidate = srcInfo
            ? canCopyVideoStream(srcInfo, range.startSec, cutOptions, [range.startSec])
            : false;
          const keyframes = copyCandidate
            ? await probeVideoKeyframes(inputPath, range.startSec, srcInfo?.videoStreamIndex).catch(() => [] as number[])
            : [];
          const videoCopy = copyCandidate && srcInfo
            ? canCopyVideoStream(srcInfo, range.startSec, cutOptions, keyframes)
            : false;
          videoMode = await cutClip(
            inputPath,
            cutTarget,
            range.startSec,
            range.endSec,
            { ...cutOptions, videoCopy },
            signal,
            onTimeSec
          );
        }
        if (cacheKey && options.renderCacheDir) {
          await storeRenderCache(
            options.renderCacheDir,
            cacheKey,
            cutTarget,
            options.renderCacheMaxBytes
          ).catch((error) => console.error(`render cache store failed for clip ${clip.id}:`, error));
        }
      }
      if (webStyle) {
        // Overlay geometry must match the base clip exactly, whatever the cut
        // pipeline produced (vertical 1080×1920 or source-sized horizontal).
        try {
          const info = await probeMedia(cutTarget);
          const scale = info.height / layout.playResY;
          const overlayLayout = {
            ...layout,
            playResX: info.width,
            playResY: info.height,
            fontSize: Math.round(layout.fontSize * scale),
            marginV: Math.round(layout.marginV * scale),
            marginH: Math.round(layout.marginH * scale),
          };
          const relWords = captionWords!.map((w) => ({
            text: w.text,
            startSec: w.startSec - captionShift,
            endSec: w.endSec - captionShift,
            speaker: w.speaker, // keep per-word speaker so the overlay colors by talker
          }));
          const payload = buildOverlayPayload(relWords, overlayLayout, {
            keywords: clip.keywords,
            forcedBreaks: plan?.breaks,
            highlightHex: options.brand?.highlightColor,
          });
          await options.renderOverlay!(cutTarget, outPath, payload, clipDuration, webStyle, {
            color: activeColor,
            videoStreamIndex: info.videoStreamIndex,
            audioStreamIndex: info.audioStreamIndex,
          });
          await rm(cutTarget, { force: true });
        } catch (e) {
          // fail-open: ship the base clip (title card intact, no word captions)
          webRenderFailed = true;
          await rm(outPath, { force: true }).catch(() => {});
          const { rename } = await import("fs/promises");
          await rename(cutTarget, outPath);
          console.error(`overlay pass failed for clip ${clip.id}, shipped base:`, e);
        }
      }
      // 高潮前置(cold-open):钩子句剪成迷你片拼到正片前——前 3 秒决定完播,
      // 到原位置原样重复是直播切片圈通行做法;任一步失败回退原片,绝不拖垮该条
      let coldOpenSec: number | null = null;
      let coldOpenPlan: ReturnType<typeof planColdOpen> = null;
      // 迷你片是「爆点闪现」而非钩子句时为 true(回执要区分两种开场形态)
      let flashForwardUsed = false;
      // 钩子文本在 meta.hook(证据链字段),不在顶层——读错位置会让高潮前置永远不触发
      const coldOpenHook = clip.meta?.hook?.trim();
      if (!audioOnly && !webStyle && (options.flashForward || clip.flashForward || options.coldOpen)) {
        // 爆点闪现优先:两个开关同开时,视觉钩子是更强的差异化(全网仅
        // 0.04% 切片有 visual hook);闪不出来(全程无显著峰)回退钩子句。
        // clip.flashForward 是一片多版的结构差异维度(该变体单独开闪现)
        if (options.flashForward || clip.flashForward) {
          const farEnough = peakEventPairs
            .filter((p) => p.outSec >= FLASH_SKIP_NEAR_START_SEC)
            .map((p) => p.srcSec);
          coldOpenPlan = planFlashForward(
            farEnough,
            plan ? plan.segments : [{ startSec: clip.startSec, endSec: clip.endSec }]
          );
          flashForwardUsed = coldOpenPlan !== null;
        }
        if (!coldOpenPlan && options.coldOpen && coldOpenHook && clip.words && clip.words.length > 0) {
          coldOpenPlan = planColdOpen(clip.words, coldOpenHook, clip.startSec);
          // 拼接片:迷你片是从源片单独切一刀,必须整个落在某一段内,
          // 否则会把被剪掉的空隙内容当作钩子重新放进成片
          // (爆点闪现从保留段里挑窗,天然满足,无需再验)
          if (coldOpenPlan && stitched && !withinOnePiece(pieces, coldOpenPlan.startSec, coldOpenPlan.endSec)) {
            coldOpenPlan = null;
          }
        }
        const coPlan = coldOpenPlan;
        if (coPlan) {
          const miniPath = outPath.replace(/\.mp4$/, ".hook.mp4");
          const bodyPath = outPath.replace(/\.mp4$/, ".body.mp4");
          const miniDur = coPlan.endSec - coPlan.startSec;
          const ok = await (async (): Promise<boolean> => {
            // 迷你片字幕:钩子句卡拉OK照常;悬念句/标题/AIGC 徽标烧在开头这几秒
            // (钩子必须字幕可读——60%+ 移动端静音观看)
            let miniAssPath: string | undefined;
            if (assDir && needAss) {
              miniAssPath = join(assDir, `clip-${clip.id}-hook.ass`);
              const miniWords = wantCaptions
                ? clip.words!.filter((w) => w.startSec >= coPlan.startSec - 1e-3 && w.endSec <= coPlan.endSec + 1e-3)
                : [];
              const miniAss = buildCaptionAss(miniWords, coPlan.startSec, layout, assStyle, {
                keywords: clip.keywords,
                titleCard: options.titleCard ? { text: clip.title, durationSec: miniDur } : undefined,
                openingHook: openingHook ? { text: openingHook.text, durationSec: Math.min(OPENING_HOOK_SEC, miniDur) } : undefined,
                highlightHex: options.brand?.highlightColor,
                aigcBadge: options.aigcLabel ? { durationSec: miniDur } : undefined,
                speakerLabels: options.speakerLabels,
              });
              await writeFile(miniAssPath, miniAss, "utf8");
            }
            // 人脸跟随:迷你片自己算一版裁窗(keyframes 已相对段起点),失败回退中心裁
            let miniTrack;
            if (trackPlan && options.modelsRoot) {
              const cp = await generateCropPlan(inputPath, coPlan.startSec, coPlan.endSec, options.modelsRoot, uiCrop).catch(() => null);
              if (cp && cp.keyframes.length > 0) {
                miniTrack = { cropXExpr: renderCropXExpr(cp.keyframes), cropW: cp.cropW, cropH: cp.cropH, cropY: cp.cropY };
              }
            }
            const miniVisualEnhance = options.autoEnhance && allowSdrVisualEnhance
              ? planVisualEnhancement(visualSamples, [{ startSec: coPlan.startSec, endSec: coPlan.endSec }])
              : null;
            const miniCutOptions = miniTrack
              ? { ...sourceStreams, trackPlan: miniTrack, visualEnhance: miniVisualEnhance, color: activeColor, subtitlePath: miniAssPath, fontsDir: miniAssPath ? options.fontsDir : undefined, normalizeLoudness: baseNormalizeLoudness, denoise: baseDenoise, muteRanges: options.muteTerms && clip.words ? mapSensitiveRanges(clip.words, options.muteTerms, [{ startSec: coPlan.startSec, endSec: coPlan.endSec }]) : undefined, watermark, crf: options.crf, encoder: videoEncoder }
              : { ...sourceStreams, uiCrop, vertical: options.vertical, visualEnhance: miniVisualEnhance, color: activeColor, subtitlePath: miniAssPath, fontsDir: miniAssPath ? options.fontsDir : undefined, normalizeLoudness: baseNormalizeLoudness, denoise: baseDenoise, muteRanges: options.muteTerms && clip.words ? mapSensitiveRanges(clip.words, options.muteTerms, [{ startSec: coPlan.startSec, endSec: coPlan.endSec }]) : undefined, watermark, crf: options.crf, encoder: videoEncoder };
            await rename(outPath, bodyPath);
            await cutClip(inputPath, miniPath, coPlan.startSec, coPlan.endSec, miniCutOptions, signal);
            // 硬切拼接(通行做法);AIGC 隐式标识补到最终容器上
            await concatClips([miniPath, bodyPath], outPath, signal, aigcMeta);
            await rm(miniPath, { force: true });
            await rm(bodyPath, { force: true });
            return true;
          })().catch(async (e) => {
            if (signal?.aborted) throw e;
            // 回退:正片就是最终产物(rename 可能未发生或已发生,两种都兜)
            await rename(bodyPath, outPath).catch(() => {});
            await rm(miniPath, { force: true }).catch(() => {});
            return false;
          });
          if (ok) coldOpenSec = miniDur;
        }
      }

      let audioEnhancement: AudioEnhancementReceipt | undefined;
      if (options.denoise) {
        audioEnhancement = smartDenoise
          ? await applySmartDenoiseWithFallback(
              outPath,
              options.modelsRoot,
              Boolean(options.normalizeLoudness),
              signal
            )
          : { requested: "basic", applied: "basic" };
      }

      // 声音设计(音效打点 + BGM 闪避):成片完全组装好之后做一遍音频后处理
      // (视频流复制零画质损失),质检在其后照常复核最终混音。失败保留原片
      // ——音效是锦上添花,绝不拖垮出片。
      let sfxApplied: SfxCue[] = [];
      let bgmMixed = false;
      if (options.sfx || options.bgmPath) {
        const shift = coldOpenSec ?? 0;
        const soundDur = clipDuration + shift;
        // 拼接缝(输出时间轴):whoosh 卡在观众必然感知到的内容跳变处
        const stitchSeamsOut =
          stitched && plan
            ? pieces
                .slice(1)
                .map((p) => mapToOutputTime(p.startSec, plan.segments, clip.startSec))
                .filter((t): t is number => t !== null && t > 0.05)
            : [];
        const cues = options.sfx
          ? planSfxCues({
              durationSec: soundDur,
              seamsSec: [...stitchSeamsOut.map((t) => t + shift), ...(coldOpenSec ? [coldOpenSec] : [])],
              hookAtSec: openingHook ? 0.05 : null,
              peakEventsSec: peakEventsOut.map((t) => t + shift),
            })
          : [];
        if (hasSoundDesignWork({ cues, bgmPath: options.bgmPath })) {
          try {
            await applySoundDesign(
              outPath,
              {
                cues,
                sfxDir: cues.length > 0 ? await ensureSfxDir() : undefined,
                bgmPath: options.bgmPath,
                durationSec: soundDur,
                normalizeLoudness: options.normalizeLoudness,
              },
              signal
            );
            sfxApplied = cues;
            bgmMixed = Boolean(options.bgmPath);
          } catch (e) {
            if (signal?.aborted) throw e;
            console.error(`sound design failed for clip ${clip.id}, kept original:`, e);
          }
        }
      }

      const s = await stat(outPath);

      // 出片自我质检 + 平台违禁词 lint:解码扫描黑屏/长静音/响度/时长偏差,
      // 复核切点是否压在词中间,并扫标题/钩子/文案/字幕的平台风险词——
      // 回执说「AI 干了什么」,质检说「干得好不好、能不能直接发」。
      // 检测失败静默置空,绝不拖垮导出(与封面/SRT 同一兜底语义)。
      let qaReport: ClipQaReport | null = null;
      // qa 修复循环裁掉的头部时长(封面时刻/SRT 时间轴要同步前移)
      let headTrimSec = 0;
      if (options.qa !== false) {
        const contentHits = lintClipContent({
          title: clip.title,
          hook: [clip.meta?.hook, clip.meta?.teaser].filter(Boolean).join("\n") || undefined,
          publish: clip.publish ?? null,
          captionText: clip.words?.map((w) => w.text).join(""),
        });
        // 钩子兑付校验:标题/钩子/悬念句承诺的数字实体必须真实出现在片中
        // 转写里——不兑付的信息缺口 = 标题党,完播率崩且账号降权(2026 调研)
        const hookPayoffMissing =
          clip.words && clip.words.length > 0
            ? missingHookPayoffs(
                [clip.title, clip.meta?.hook, clip.meta?.teaser].filter(Boolean).join(" "),
                clip.words.map((w) => w.text).join("")
              )
            : null;
        // 节奏评估:字幕逐块上屏/自动运镜/音频波形图本身就是持续视觉变化,
        // 有其一就不评;其余按剪辑计划(跳剪缝/拼接缝/高潮前置接缝)算最长
        // 无视觉变化间隔,超 5s 在 qa 里告警(见 qa.ts PACING_MAX_GAP_SEC)
        const pacingCovered = Boolean(autoZoom) || (wantCaptions && !webRenderFailed) || audioOnly;
        const pacingGapSec = pacingCovered
          ? null
          : maxVisualGapSec(
              [...(plan?.breaks ?? []).map((b) => b + (coldOpenSec ?? 0)), ...(coldOpenSec ? [coldOpenSec] : [])],
              clipDuration + (coldOpenSec ?? 0)
            );
        const qaOptsBase = {
          loudnessNormalized: Boolean(options.normalizeLoudness),
          words: clip.words,
          segments: plan ? plan.segments : [{ startSec: clip.startSec, endSec: clip.endSec }],
          contentHits,
          pacingGapSec,
          hookPayoffMissing,
          subjectCoverage: reframeCoverage,
          signal,
        };
        const expected = clipDuration + (coldOpenSec ?? 0);
        qaReport = await runClipQa(outPath, { ...qaOptsBase, expectedDurationSec: expected }).catch((e) => {
          if (signal?.aborted) throw e;
          return null;
        });
        // qa 修复循环(一轮):可自愈的告警——首尾静音/黑屏(裁边)、响度偏差
        // (二遍归一)——当场修掉再重检,告警变少才替换成片;修复失败或没
        // 变好都保留原片并记录尝试(qa.repair)。
        if (qaReport?.status === "warn" && options.qaRepair !== false) {
          const repairPlan = planRepair(qaReport, {
            normalizeLoudness: Boolean(options.normalizeLoudness),
            headTrimmable: coldOpenSec === null,
          });
          if (repairPlan) {
            const repairMedia = await probeMedia(outPath).catch(() => null);
            const outcome = await applyRepair(
              outPath,
              repairPlan,
              qaReport,
              (fixedPath) =>
                runClipQa(fixedPath, { ...qaOptsBase, expectedDurationSec: expected - repairPlan.trimmedSec }),
              signal,
              activeColor,
              repairMedia?.videoStreamIndex,
              repairMedia?.audioStreamIndex
            ).catch((e) => {
              if (signal?.aborted) throw e;
              return null;
            });
            if (outcome) {
              qaReport = outcome.report;
              if (outcome.applied) headTrimSec = repairPlan.trimStartSec;
            }
          }
        }
      }
      // 修复裁过边的用实测时长,其余沿用管线预期时长(行为不变)
      const finalDurationSec = qaReport?.repair?.applied ? qaReport.durationSec : clipDuration + (coldOpenSec ?? 0);

      // Cover: a frame just after the hook lands, pulled from the FINISHED
      // clip so captions/title plate are baked in — platform-upload ready.
      const coverPath = outPath.replace(/\.mp4$/, ".jpg");
      // 智能封面:切片内响度最高的一帧(峰值≈情绪最高点);没跳剪时补提一次
      // 峰值轨,失败回退固定 0.8s 帧
      if (!clipPeaks && !peakSpanTooLong(clip)) {
        clipPeaks = await extractPeaks(inputPath, clip.startSec, clip.endSec, srcInfo?.audioStreamIndex).catch(() => undefined);
      }
      // cold-open 让输出时间轴整体后移一个迷你片时长,封面时刻同步平移;
      // qa 修复裁头则整体前移,并钳进修复后的实际时长
      const coverAtRaw =
        pickCoverTime(
          clipPeaks,
          plan ? plan.segments : [{ startSec: clip.startSec, endSec: clip.endSec }],
          clipDuration,
          clip.coverRank ?? 0 // 变体封面抓下一个响度峰,和原版错开帧
        ) + (coldOpenSec ?? 0) - headTrimSec;
      const clampCoverAt = (at: number): number =>
        Math.min(Math.max(0.2, at), Math.max(0.2, finalDurationSec - 0.2));
      const fallbackCoverAt = clampCoverAt(coverAtRaw);
      const coverCandidates = proposeCoverTimes(
        clipPeaks,
        plan ? plan.segments : [{ startSec: clip.startSec, endSec: clip.endSec }],
        clipDuration
      ).map((candidate) => ({
        ...candidate,
        atSec: clampCoverAt(candidate.atSec + (coldOpenSec ?? 0) - headTrimSec),
      })).filter((candidate, index, all) =>
        all.findIndex((item) => Math.abs(item.atSec - candidate.atSec) < 0.05) === index
      );
      const coverSelection = await selectQualityCoverTime({
        videoPath: outPath,
        candidates: coverCandidates,
        fallbackSec: fallbackCoverAt,
        rank: clip.coverRank ?? 0,
        signal,
      }).catch((error) => {
        if (signal?.aborted) throw error;
        return {
          selectedSec: Number(fallbackCoverAt.toFixed(3)),
          fallbackSec: Number(fallbackCoverAt.toFixed(3)),
          mode: "fallback" as const,
          candidatesEvaluated: 0,
          candidatesRejected: 0,
        };
      });
      const coverAt = coverSelection.selectedSec;
      const coverOk = await execFileAsync(
        resolveFfmpegPath(),
        ["-hide_banner", "-v", "error", "-ss", coverAt.toFixed(2), "-i", outPath, "-frames:v", "1", "-q:v", "2", "-y", coverPath],
        { maxBuffer: 8 * 1024 * 1024 }
      ).then(() => true, () => false);

      // SRT 字幕文件:与烧录字幕同一套词/断行/时间基(跳剪重映射后),
      // 平台原生字幕上传与二次精修用
      if (options.subtitleFile && wantCaptions) {
        // cold-open 后正片词整体后移;qa 修复裁头则整体前移
        const shift = (coldOpenSec ?? 0) - headTrimSec;
        let relWords = captionWords!.map((w) => ({
          text: w.text,
          startSec: w.startSec - captionShift + shift,
          endSec: w.endSec - captionShift + shift,
        }));
        // 前置的钩子迷你片:词平移到 0 起,排在正片词前(与成片画面一致)
        if (coldOpenSec && coldOpenPlan && clip.words) {
          const co = coldOpenPlan;
          const miniRel = clip.words
            .filter((w) => w.startSec >= co.startSec - 1e-3 && w.endSec <= co.endSec + 1e-3)
            .map((w) => ({ text: w.text, startSec: w.startSec - co.startSec, endSec: w.endSec - co.startSec }));
          relWords.unshift(...miniRel);
        }
        // qa 修复裁过边:被裁掉的头尾词不再出现在画面里,SRT 同步丢弃
        const repaired = qaReport?.repair?.applied === true;
        if (repaired) {
          relWords = relWords.filter((w) => w.endSec > 0.05 && w.startSec < finalDurationSec - 0.05);
        }
        const relTrans = transLines
          .map((l) => ({
            startSec: l.startSec - captionShift + shift,
            endSec: l.endSec - captionShift + shift,
            text: l.text,
          }))
          .filter((l) => !repaired || (l.endSec > 0.05 && l.startSec < finalDurationSec - 0.05));
        // 断行点与词同基:正片整体平移后,跳剪的强制断行时刻也要同步平移;
        // cold-open 接缝处强制断行(钩子行与正片首句不并行)
        const breaks = [...(shift > 0 ? [shift] : []), ...(plan?.breaks ?? []).map((b) => b + shift)];
        const srt = buildSrt(srtLinesFromWords(relWords, breaks, relTrans));
        if (srt.trim()) {
          await writeFile(outPath.replace(/\.mp4$/, ".srt"), srt, "utf8").catch(() => {});
        }
      }

      // 发布文案:mp4 旁落同名 .post.txt(标题+话题+简介,直接全选复制)
      if (clip.publish) {
        await writeFile(outPath.replace(/\.mp4$/, ".post.txt"), postTextFile(clip.publish, Boolean(options.aigcLabel)), "utf8").catch(() => {});
      }

      results.push({
        id: clip.id,
        title: clip.title,
        path: outPath,
        coverPath: coverOk ? coverPath : undefined,
        sizeBytes: s.size,
        durationSec: finalDurationSec,
        colorConverted: Boolean(activeColor),
        colorConversionSkipped: Boolean(hdrDetected && !activeColor),
        colorInspectionFailed,
        audioEnhancement: audioEnhancement?.applied,
        qa: qaReport,
      });
      if (fillerHits.length > 0) {
        removedFillersByClip.set(clip.id, fillerHits.map((h) => h.text.trim()));
      }
      // 变体与原版切点完全相同,EDL 里只记原版(重复三遍是噪声)
      if (!clip.variantOf) {
        edlClips.push({
          title: clip.title,
          segments: plan ? plan.segments : [{ startSec: clip.startSec, endSec: clip.endSec }],
        });
      }
      // 剪掉多少的基准:拼接片按「各段之和」算(跨度里那几十分钟本来就不该
      // 进成片,拿它当分母会报出「剪掉了 97%」这种毫无意义的数)
      const origDur = stitched ? piecesDurationSec(pieces) : clip.endSec - clip.startSec;
      renderByClip.set(clip.id, {
        captionStyle: wantCaptions ? (webStyle ?? assStyle) : "none",
        captionsBurned: wantCaptions && !webRenderFailed,
        reframe: audioOnly ? "audiogram" : options.vertical ? (trackPlan ? "face-track" : "center-crop") : "none",
        reframeComposition,
        edit: summarizeEdit(origDur, plan),
        fillersRemoved: fillerHits.length,
        retakesRemoved: retakeHits.length,
        stitchedPieces: stitched ? pieces.length : 0,
        loudnessNormalized: Boolean(options.normalizeLoudness),
        denoised: Boolean(options.denoise),
        audioEnhancement,
        visualEnhance,
        color,
        sensitiveMutes: sensitiveMuteRanges?.length ?? 0,
        coldOpenSec,
        flashForward: flashForwardUsed,
        openingHookBurned: Boolean(openingHook),
        translatedLines: transLines.length,
        shotSnap,
        speechActivity,
        preciseAligned,
        alignment,
        subtitleQuality,
        sfxCues: sfxApplied.length,
        bgmMixed,
        renderCache,
        videoMode,
        coverSelection,
      });
      onProgress?.({ current: i + 1, total: totalUnits, clipId: clip.id, stage: "done" });
    }

    // 精华合集:同批切片编码参数一致,流复制拼接秒级完成零画质损失;
    // 合集惯例硬切不加转场;失败静默跳过,绝不拖垮已导出的单条切片
    let compilationFile: string | null = null;
    // 合集只收原版:变体是同一段内容的另一套包装,拼进合集就是重复播三遍
    const compResults = results.filter((r) => !clips.find((c) => c.id === r.id)?.variantOf);
    if (options.compilation && compResults.length > 1) {
      const compPath = join(outDir, "00-精华合集.mp4");
      const totalSec = compResults.reduce((a, r) => a + r.durationSec, 0);
      const ok = await concatClips(compResults.map((r) => r.path), compPath, signal)
        .then(() => true)
        .catch((e) => {
          // 用户取消要向上抛(与单条切片同一语义),其余失败静默
          if (signal?.aborted) throw e;
          return false;
        });
      if (ok) {
        const cs = await stat(compPath).catch(() => null);
        compilationFile = basename(compPath);
        // 章节时间戳:YouTube 章节/B站简介粘贴即用,B站还可照此拆分P
        await writeFile(
          compPath.replace(/\.mp4$/, ".chapters.txt"),
          buildChapters(compResults.map((r) => ({ title: r.title, durationSec: r.durationSec }))),
          "utf8"
        ).catch(() => {});
        results.push({
          id: 0,
          title: "精华合集",
          path: compPath,
          sizeBytes: cs?.size ?? 0,
          durationSec: totalSec,
          colorConverted: Boolean(activeColor),
          colorConversionSkipped: Boolean(hdrDetected && !activeColor),
          colorInspectionFailed,
        });
      }
    }

    // 主题系列包:只收原版,避免一片多版被误当成连续剧集;按源时间排序。
    // 归组/文件失败均 fail-open,不影响已经完成的成片。
    let seriesSummary: SeriesPackSummary | null = null;
    if (options.seriesPack && compResults.length > 1) {
      seriesSummary = await buildSeriesPack(
        outDir,
        compResults.map((result) => {
          const spec = clips.find((clip) => clip.id === result.id);
          return {
            file: result.path,
            title: result.title,
            keywords: spec?.keywords,
            sourceStartSec: spec?.startSec,
          };
        })
      ).catch(() => null);
    }

    // 时间线 EDL:切点(含跳剪内部剪)交给剪辑软件重链源片精修;失败不拖垮导出
    if (options.timeline && edlClips.length > 0) {
      const fps = srcInfo && srcInfo.fps > 0 ? srcInfo.fps : 30;
      const edl = buildEdl({
        title: `${basename(inputPath)} - HotClip`,
        sourceName: basename(inputPath),
        fps,
        clips: edlClips,
      });
      await writeFile(join(outDir, "timeline.edl"), edl, "utf8").catch(() => {});
    }

    // 剪映草稿:每条切片一个草稿文件夹(含跳剪的每一段),整夹拷进剪映
    // 草稿目录即可打开精修——EDL 的国民级剪辑器版本。纯音频源无画面轨,
    // 草稿无意义跳过;单条失败静默,绝不拖垮导出。
    if (options.jianyingDraft && edlClips.length > 0 && srcInfo && srcInfo.hasVideo) {
      const draftsRoot = join(outDir, "剪映草稿");
      const fps = srcInfo.fps > 0 ? Math.round(srcInfo.fps) : 30;
      for (let d = 0; d < edlClips.length; d++) {
        const ec = edlClips[d];
        try {
          const folder = join(draftsRoot, `${String(d + 1).padStart(2, "0")}-${sanitizeFilename(ec.title)}`);
          await mkdir(folder, { recursive: true });
          const content = buildDraftContent({
            sourcePath: inputPath,
            sourceName: basename(inputPath),
            sourceDurationSec: srcInfo.durationSec,
            width: srcInfo.width,
            height: srcInfo.height,
            fps,
            clip: ec,
          });
          await writeFile(join(folder, "draft_content.json"), JSON.stringify(content, null, 4), "utf8");
          await writeFile(join(folder, "draft_meta_info.json"), JSON.stringify(buildDraftMetaInfo(), null, 4), "utf8");
        } catch {
          /* fail-open:草稿是附加产物 */
        }
      }
    }

    // 平台发布包:每平台一个文件夹,视频硬链+按平台画幅裁的封面+按平台上限
    // 适配的文案,拿起来就能发。只打包切片本体(合集另论);fail-open。
    let packSummaries: PackSummary[] = [];
    if (options.publishPack && options.publishPack.length > 0 && results.length > 0) {
      const packInputs = results
        .filter((r) => clips.some((c) => c.id === r.id))
        .map((r) => {
          const spec = clips.find((c) => c.id === r.id)!;
          return { file: r.path, coverFile: r.coverPath, title: r.title, publish: spec.publish };
        });
      packSummaries = await buildPublishPacks(outDir, packInputs, options.publishPack, async (src, dest, spec) => {
        // 封面适配:裁到平台画幅(上偏 1/3 保人脸)再缩放到推荐像素
        return execFileAsync(
          resolveFfmpegPath(),
          ["-hide_banner", "-v", "error", "-i", src, "-vf", coverFilter(spec), "-frames:v", "1", "-q:v", "2", "-y", dest],
          { maxBuffer: 8 * 1024 * 1024 }
        ).then(() => true, () => false);
      }, Boolean(options.aigcLabel)).catch(() => []);
    }

    // 留证包(v0.14 可选):每条切片截源片前后各 3 分钟流复制留档——2026-07
    // 起授权审核要求留存片段前后 ≥3 分钟原始录屏。流复制不重编码,秒级完成;
    // 单条失败跳过,绝不拖垮导出。
    if (options.evidencePack && results.length > 0) {
      const evDir = join(outDir, "留证");
      await mkdir(evDir, { recursive: true }).catch(() => {});
      for (const r of results) {
        const range = snappedRange.get(r.id);
        const spec = clips.find((c) => c.id === r.id);
        const start = range?.startSec ?? spec?.startSec;
        const end = range?.endSec ?? spec?.endSec;
        if (start === undefined || end === undefined) continue;
        const dest = join(evDir, basename(r.path).replace(/\.mp4$/, "-前后3分钟.mp4"));
        await execFileAsync(
          resolveFfmpegPath(),
          [
            "-hide_banner", "-v", "error",
            "-ss", Math.max(0, start - 180).toFixed(2),
            "-to", (end + 180).toFixed(2),
            "-i", inputPath,
            "-c", "copy", "-y", dest,
          ],
          { maxBuffer: 8 * 1024 * 1024 }
        ).catch(() => {});
      }
    }

    // AI 封面双档(v0.14):只给原版生成(变体的封面差异化已有响度峰机制,
    // 逐版生成是翻倍花费);合集(id 0)/横屏副本(负 id)不生成。并行出图,
    // 单张失败静默——封面是加分项,绝不拖垮导出。
    const aiCoverByClip = new Map<number, string>();
    if (options.aiCover && results.length > 0) {
      const ac = options.aiCover;
      await Promise.allSettled(
        results
          .filter((r) => r.id > 0 && !clips.find((c) => c.id === r.id)?.variantOf)
          .map(async (r) => {
            const spec = clips.find((c) => c.id === r.id);
            const outPath = r.path.replace(/\.mp4$/, ".封面AI.jpg");
            const ok = await generateAiCover({
              tier: ac.tier,
              title: r.title,
              hook: spec?.meta?.hook,
              visualContext: spec?.meta?.visualEvidence?.scene,
              zh: ac.zh !== false,
              baseUrl: ac.baseUrl,
              apiKey: ac.apiKey,
              outPath,
              signal,
            }).catch((e) => {
              console.error(`ai cover failed for clip ${r.id}:`, e);
              return false;
            });
            if (ok) aiCoverByClip.set(r.id, outPath);
          })
      );
      if (signal?.aborted) throw new Error("export cancelled");
    }

    // clips.json: machine-readable evidence chain for CMS / matrix pipelines.
    const metadata = {
      source: inputPath,
      exportedAt: new Date().toISOString(),
      options: {
        vertical: Boolean(options.vertical),
        captionStyle: options.captionStyle ?? "none",
        jumpCut: Boolean(options.jumpCut),
        cleanFillers: Boolean(options.cleanFillers),
        cutRetakes: Boolean(options.cutRetakes),
        autoZoom: Boolean(options.autoZoom),
        sfx: Boolean(options.sfx),
        bgm: Boolean(options.bgmPath),
        trimUi: Boolean(options.trimUi),
        titleCard: Boolean(options.titleCard),
        openingHook: Boolean(options.openingHook),
        normalizeLoudness: Boolean(options.normalizeLoudness),
        denoise: Boolean(options.denoise),
        denoiseMode: options.denoise ? options.denoiseMode ?? "basic" : null,
        autoEnhance: Boolean(options.autoEnhance),
        coldOpen: Boolean(options.coldOpen),
        flashForward: Boolean(options.flashForward),
        compilation: compilationFile,
        snapToShots: Boolean(options.snapToShots),
        preciseAlign: Boolean(options.alignWords),
        // 双语字幕回执:目标语言;实际每条烧了几行见 clips[].render.translatedLines
        translateLang: options.translateLang ?? null,
        subtitleFile: Boolean(options.subtitleFile),
        timeline: Boolean(options.timeline),
        aigcLabel: Boolean(options.aigcLabel),
        qa: options.qa !== false,
        qaRepair: options.qa !== false && options.qaRepair !== false,
        // 品牌预设回执:用了什么色/档位/水印,矩阵管线可核对品牌一致性
        brand: options.brand
          ? {
              highlightColor: options.brand.highlightColor ?? null,
              fontScale: options.brand.fontScale ?? 1,
              captionPosition: options.brand.captionPosition ?? "standard",
              watermark: options.brand.watermark
                ? { corner: options.brand.watermark.corner, opacity: options.brand.watermark.opacity }
                : null,
            }
          : null,
        // 发布包回执:打了哪些平台的包、各有几条标题被截断
        publishPack:
          packSummaries.length > 0
            ? packSummaries.map((p) => ({ platform: p.platform, name: p.name, clipCount: p.clipCount, truncatedTitles: p.truncatedTitles }))
            : null,
        seriesPack: seriesSummary
          ? { seriesCount: seriesSummary.seriesCount, clipCount: seriesSummary.clipCount, topics: seriesSummary.series.map((item) => item.topic) }
          : null,
      },
      clips: results.map((r) => {
        const spec = clips.find((c) => c.id === r.id);
        const range = snappedRange.get(r.id);
        // 变形度评分(v0.14):按实际发生的变形项算,低分 = 接近「裁一刀直接发」
        const render = renderByClip.get(r.id);
        const transform: TransformScore | null = render ? transformScore(transformInputsFromRender(render, options)) : null;
        return {
          file: basename(r.path),
          cover: r.coverPath ? basename(r.coverPath) : null,
          // AI 生成封面(v0.14 双档):与抓帧封面并存,由用户挑着用
          aiCover: aiCoverByClip.has(r.id) ? basename(aiCoverByClip.get(r.id)!) : null,
          title: r.title,
          durationSec: Number(r.durationSec.toFixed(3)),
          colorConverted: Boolean(r.colorConverted),
          colorConversionSkipped: Boolean(r.colorConversionSkipped),
          colorInspectionFailed: Boolean(r.colorInspectionFailed),
          sourceStartSec: range?.startSec ?? spec?.startSec ?? null,
          sourceEndSec: range?.endSec ?? spec?.endSec ?? null,
          // 多片段拼接的段清单(单段切片为 null)——矩阵管线核对成片由哪几处拼成
          sourcePieces:
            piecesByClip.get(r.id)?.map((p) => ({
              startSec: Number(p.startSec.toFixed(3)),
              endSec: Number(p.endSec.toFixed(3)),
            })) ?? null,
          keywords: spec?.keywords ?? [],
          // 一片多版:变体标注它是哪条原版的第几版(原版两个字段都是 null)
          variantOf: spec?.variantOf ?? null,
          variant: spec?.variant ?? null,
          removedFillers: removedFillersByClip.get(r.id) ?? [],
          render: render ?? null,
          // 变形度(0-100)与档位:warn = 有搬运判定风险(Reels 视觉指纹/抖音信息熵口径)
          transform: transform ? { score: transform.score, level: transform.level } : null,
          // 出片质检报告:pass/warn + 告警清单(黑屏/静音/响度/时长/半词)
          qa: r.qa ?? null,
          // 发布文案(标题/话题/简介),同内容也落在 mp4 旁的 .post.txt
          publish: spec?.publish ?? null,
          ...(spec?.meta ?? {}),
        };
      }),
    };
    await writeFile(join(outDir, "clips.json"), JSON.stringify(metadata, null, 2), "utf8").catch(() => {});

    // 分发台账(v0.14):逐条「成片↔源区间↔导出时间」记录 + 发布侧留空列,
    // 对上 2026-07 授权审核「一视频一条分发记录」的台账要求。零成本常开。
    const ledgerRows: LedgerRow[] = results
      .filter((r) => r.id > 0) // 合集(id 0)与横屏副本(负 id)不进台账
      .map((r) => {
        const spec = clips.find((c) => c.id === r.id);
        const range = snappedRange.get(r.id);
        const render = renderByClip.get(r.id);
        return {
          file: basename(r.path),
          title: r.title,
          durationSec: r.durationSec,
          source: inputPath,
          sourceStartSec: range?.startSec ?? spec?.startSec ?? null,
          sourceEndSec: range?.endSec ?? spec?.endSec ?? null,
          pieces: piecesByClip.get(r.id)?.length ?? 1,
          exportedAt: metadata.exportedAt,
          aigcLabel: Boolean(options.aigcLabel),
          transformScore: render ? transformScore(transformInputsFromRender(render, options)).score : null,
        };
      });
    if (ledgerRows.length > 0) {
      await writeFile(join(outDir, "分发台账.csv"), buildLedgerCsv(ledgerRows), "utf8").catch(() => {});
    }

    // 多画幅:整条管线用 vertical:false 递归再跑一遍到「横屏/」子目录——
    // 横屏字幕布局/封面/回执全部自动正确;失败静默,绝不拖垮已出的竖屏版。
    // 进度事件续接主循环(current 偏移 N,total 沿用翻倍后的 totalUnits)。
    if (alsoLandscape) {
      const subResults = await exportClips(
        inputPath,
        clips,
        join(outDir, "横屏"),
        // 标题贴片/悬念句大字是竖屏短视频形态,横屏版去掉(标题交给平台标题字段);
        // 字幕沿用横屏布局(底部小号),封面/回执/SRT 在子目录各自成套
        // publishPack 只在主目录打一次(横屏版在包 manifest 的备注里指路)
        { ...options, vertical: false, alsoLandscape: false, faceTrack: false, compilation: false, timeline: false, titleCard: false, openingHook: false, publishPack: undefined, seriesPack: false },
        onProgress
          ? (p) => onProgress({ ...p, current: p.current + clips.length, total: totalUnits })
          : undefined,
        signal
      ).catch((e) => {
        if (signal?.aborted) throw e;
        return [] as ExportedClip[];
      });
      // 横屏版并入结果:id 取负避免与竖屏版/合集(id 0)相撞
      for (const r of subResults) {
        results.push({ ...r, id: -Math.abs(r.id) - 1, title: `${r.title}(横屏)` });
      }
    }

    return results;
  } finally {
    if (assDir) await rm(assDir, { recursive: true, force: true }).catch(() => {});
    if (sfxDir) await rm(sfxDir, { recursive: true, force: true }).catch(() => {});
  }
}
