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
import { cutClip, cutJumpClip, concatClips } from "./cut";
import { planColdOpen } from "./coldopen";
import { computeJumpCut } from "./gaps";
import { clampTranslationLines, remapTranslationLines, type TranslationLine } from "./translate";
import { postTextFile, type PublishCopy } from "./publish";
import { buildSrt, srtLinesFromWords } from "./srt";
import { buildEdl, type EdlClip } from "./edl";
import { runAudiogram, audiogramSpec } from "./audiogram";
import { pickCoverTime } from "./cover";
import { findFillerWords, dropFillerWords, fillerCutSpans, type FillerHit } from "./fillers";
import { extractPeaks } from "./audio-peaks";
import { detectUiCrop, type UiCrop } from "./uicrop";
import { generateCropPlan, renderCropXExpr, mapToOutputTime } from "./reframe";
import { detectShotBoundaries, snapClipToShots, SNAP_MAX_OUT_SEC } from "./shots";
import { buildCaptionAss, VERTICAL_LAYOUT, HORIZONTAL_LAYOUT, type CaptionStyle } from "./subtitle";
import { buildOverlayPayload, isWebCaptionStyle, type OverlayRenderFn, type WebCaptionStyle } from "./caption-overlay/payload";
import { probeMedia } from "./probe";
import { runClipQa, type ClipQaReport } from "./qa";
import { lintClipContent } from "./content-lint";
import { planRepair, applyRepair } from "./repair";
import { applyBrandToLayout } from "./brand";
import type { TranscriptWord, BrandStyle } from "../shared/api-types";
import type { WatermarkSpec } from "./cut";

export interface ExportClipSpec {
  id: number;
  title: string;
  startSec: number;
  endSec: number;
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
  /** Evidence-chain fields carried into clips.json for CMS/matrix pipelines. */
  meta?: {
    hook: string;
    score: number;
    reason: string;
    text: string;
    recommended: boolean;
    reviewNote: string;
    scoreDims?: { hook: number; flow: number; value: number; trend: number };
    teaser?: string;
  };
}

/** How long the opening hook (teaser) stays on screen — the 黄金3秒 window. */
const OPENING_HOOK_SEC = 2.2;

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

/** What the pipeline actually did to one clip — surfaced in clips.json. */
export interface ClipRenderOutcome {
  /** Effective caption style burned in ("none" when captions were skipped). */
  captionStyle: string;
  /** False when a web-overlay pass failed and the clip shipped without word captions. */
  captionsBurned: boolean;
  /** "face-track" when the crop followed a face, "center-crop" on fallback, "none" for horizontal, "audiogram" for audio-only sources. */
  reframe: "face-track" | "center-crop" | "none" | "audiogram";
  /** Jump-cut / filler splice outcome; null when the clip was cut whole. */
  edit: { splices: number; keptSec: number; removedSec: number; cutRatio: number } | null;
  /** Number of filler/stutter words removed. */
  fillersRemoved: number;
  /** True when audio was matched to the -14 LUFS social loudness target. */
  loudnessNormalized: boolean;
  /** True 表示走了基础降噪链(高通×2+afftdn)。 */
  denoised: boolean;
  /** 高潮前置迷你片时长(秒);没开/钩子定位失败/被守卫跳过为 null。 */
  coldOpenSec: number | null;
  /** True when the AI teaser was burned in as an opening hook. */
  openingHookBurned: boolean;
  /** 实际烧进画面的译文行数;没开双语/翻译失败为 0。 */
  translatedLines: number;
  /** 切点吸附到镜头边界的实际位移(秒);没吸附(或检测失败)为 null。 */
  shotSnap: { startDeltaSec: number; endDeltaSec: number } | null;
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
  /** Splice out hesitation sounds (嗯/呃/um/uh) and stutter repeats. */
  cleanFillers?: boolean;
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
  /** 精华合集:导出的切片按时间序流复制拼成一支合集(≥2 条才生成)。 */
  compilation?: boolean;
  /** 高潮前置:钩子句剪成迷你片拼到切片开头再接完整正片(cold-open)。 */
  coldOpen?: boolean;
  /** 多画幅:竖屏之外再出一版横屏原画幅(落 `横屏/` 子目录,竖版发抖音横版发B站)。 */
  alsoLandscape?: boolean;
  /** 切点吸附镜头边界(TransNetV2,需 modelsRoot);检测失败静默回退不吸附。 */
  snapToShots?: boolean;
  /** 品牌样式预设(高亮色/字号/位置/水印);缺省走内置默认,输出不变。 */
  brand?: BrandStyle;
  /** 双语字幕的目标语言(回执用;译文本身随 ExportClipSpec.translation 传入)。 */
  translateLang?: string;
  /** 每条切片旁落同名 .srt 字幕文件(平台字幕上传/二次精修用)。 */
  subtitleFile?: boolean;
  /** 输出目录落 timeline.edl(CMX3600)——切点交给剪辑软件重链源片精修。 */
  timeline?: boolean;
  /** AIGC 标识:左上角「AI 生成」显式标识 + 容器元数据隐式标识(《标识办法》)。 */
  aigcLabel?: boolean;
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
}

export interface ExportedClip {
  id: number;
  title: string;
  path: string;
  /** Cover JPG next to the clip (frame from just after the hook). */
  coverPath?: string;
  sizeBytes: number;
  durationSec: number;
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
  // 品牌预设:字号/位置作用于布局,高亮色传给字幕构建,水印挂进 filter 链
  const layout = applyBrandToLayout(options.vertical ? VERTICAL_LAYOUT : HORIZONTAL_LAYOUT, options.brand);
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
  const audioOnly = srcInfo ? !srcInfo.hasVideo : false;

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
    uiCrop = await detectUiCrop(inputPath, spanEnd).catch(() => undefined);
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
    // 时间线导出:每条切片实际保留的源片区间(跳剪时一条多段)
    const edlClips: EdlClip[] = [];
    for (let i = 0; i < clips.length; i++) {
      let clip = clips[i];
      if (signal?.aborted) throw new Error("export cancelled");
      onProgress?.({ current: i + 1, total: totalUnits, clipId: clip.id, stage: "cutting" });

      // 切点吸附:起止点吸到最近的镜头边界(词边界守卫,检测失败回退不吸附)。
      // 必须在跳剪/字幕/取景之前调整——下游全部消费 clip.startSec/endSec。
      let shotSnap: ClipRenderOutcome["shotSnap"] = null;
      if (options.snapToShots && options.modelsRoot && !clip.manualBounds && !audioOnly) {
        const pad = SNAP_MAX_OUT_SEC + 0.4;
        const boundaries = await detectShotBoundaries(
          inputPath, clip.startSec - pad, clip.endSec + pad, options.modelsRoot
        ).catch(() => [] as number[]);
        const w = clip.words;
        const snap = snapClipToShots(clip.startSec, clip.endSec, boundaries, {
          firstWordStartSec: w?.[0]?.startSec,
          lastWordEndSec: w && w.length > 0 ? w[w.length - 1].endSec : undefined,
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
      let plan = null;
      let fillerHits: FillerHit[] = [];
      // 峰值轨提升作用域:跳剪的静音门用,封面选帧也用(见下)
      let clipPeaks: Awaited<ReturnType<typeof extractPeaks>> | undefined;
      if ((options.jumpCut || options.cleanFillers) && clip.words && clip.words.length > 0) {
        fillerHits = options.cleanFillers ? findFillerWords(clip.words) : [];
        const planWords = dropFillerWords(clip.words, fillerHits);
        const peaks = options.jumpCut
          ? await extractPeaks(inputPath, clip.startSec, clip.endSec).catch(() => undefined)
          : undefined;
        clipPeaks = peaks;
        // filler-only mode with nothing found → leave the clip untouched
        if (options.jumpCut || fillerHits.length > 0) {
          plan = computeJumpCut(planWords, clip.startSec, clip.endSec, {
            peaks,
            forceCutSpans: fillerCutSpans(fillerHits),
            gapThresholdSec: options.jumpCut ? undefined : Infinity,
          });
        }
      }
      const captionWords = plan ? plan.words : clip.words;
      const captionShift = plan ? 0 : clip.startSec;

      const clipDuration = plan ? plan.durationSec : clip.endSec - clip.startSec;
      let subtitlePath: string | undefined;
      const wantCaptions = Boolean(options.captionStyle && captionWords && captionWords.length > 0);
      // Web styles render words in the overlay pass; ASS then only draws the
      // title card. ASS styles burn everything in one libass pass as before.
      const webStyle = isWebCaptionStyle(options.captionStyle) && wantCaptions && options.renderOverlay
        ? options.captionStyle
        : undefined;
      const assStyle: CaptionStyle = isWebCaptionStyle(options.captionStyle) ? "karaoke" : (options.captionStyle ?? "karaoke");
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
          }
        );
        await writeFile(subtitlePath, ass, "utf8");
      }

      // Face-aware reframe: plan per clip; any failure falls back to center.
      let trackPlan;
      if (options.vertical && options.faceTrack && options.modelsRoot && !audioOnly) {
        const cp = await generateCropPlan(
          inputPath, clip.startSec, clip.endSec, options.modelsRoot, uiCrop
        ).catch(() => null);
        if (cp) {
          let kfs = cp.keyframes;
          if (plan) {
            // jump cut: remap keyframes onto the compressed output timeline
            kfs = kfs
              .map((k) => {
                const t = mapToOutputTime(k.t, plan.segments, clip.startSec);
                return t === null ? null : { t, x: k.x };
              })
              .filter((k): k is { t: number; x: number } => k !== null);
          }
          if (kfs.length > 0) {
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
      const cutOptions = trackPlan
        ? { trackPlan, subtitlePath, fontsDir: subtitlePath ? options.fontsDir : undefined, normalizeLoudness: options.normalizeLoudness, denoise: options.denoise, watermark, metadata: aigcMeta }
        : {
            uiCrop,
            vertical: options.vertical,
            subtitlePath,
            fontsDir: subtitlePath ? options.fontsDir : undefined,
            normalizeLoudness: options.normalizeLoudness,
            denoise: options.denoise,
            watermark,
            metadata: aigcMeta,
          };
      if (audioOnly) {
        // audiogram:深色底+品牌色波形合成画面,单段/跳剪统一(波形随剪好的音频生成)
        await runAudiogram(
          inputPath,
          cutTarget,
          plan ? plan.segments : [{ startSec: clip.startSec, endSec: clip.endSec }],
          {
            // 与 ASS layout 的竖/横选择严格一致,playRes 才对得上
            spec: audiogramSpec(Boolean(options.vertical), options.brand?.highlightColor),
            subtitlePath,
            fontsDir: subtitlePath ? options.fontsDir : undefined,
            normalizeLoudness: options.normalizeLoudness,
            denoise: options.denoise,
            watermark,
            metadata: aigcMeta,
          },
          signal,
          onTimeSec
        );
      } else if (plan && plan.segments.length > 1) {
        await cutJumpClip(inputPath, cutTarget, clip.startSec, plan.segments, cutOptions, signal, onTimeSec);
      } else {
        // single kept segment → plain cut (honoring trimmed lead-in/tail)
        const range = plan?.segments[0] ?? { startSec: clip.startSec, endSec: clip.endSec };
        await cutClip(inputPath, cutTarget, range.startSec, range.endSec, cutOptions, signal, onTimeSec);
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
          await options.renderOverlay!(cutTarget, outPath, payload, clipDuration, webStyle);
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
      // 钩子文本在 meta.hook(证据链字段),不在顶层——读错位置会让高潮前置永远不触发
      const coldOpenHook = clip.meta?.hook?.trim();
      if (options.coldOpen && !audioOnly && !webStyle && coldOpenHook && clip.words && clip.words.length > 0) {
        coldOpenPlan = planColdOpen(clip.words, coldOpenHook, clip.startSec);
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
            const miniCutOptions = miniTrack
              ? { trackPlan: miniTrack, subtitlePath: miniAssPath, fontsDir: miniAssPath ? options.fontsDir : undefined, normalizeLoudness: options.normalizeLoudness, denoise: options.denoise, watermark }
              : { uiCrop, vertical: options.vertical, subtitlePath: miniAssPath, fontsDir: miniAssPath ? options.fontsDir : undefined, normalizeLoudness: options.normalizeLoudness, denoise: options.denoise, watermark };
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
        const qaOptsBase = {
          loudnessNormalized: Boolean(options.normalizeLoudness),
          words: clip.words,
          segments: plan ? plan.segments : [{ startSec: clip.startSec, endSec: clip.endSec }],
          contentHits,
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
            const outcome = await applyRepair(
              outPath,
              repairPlan,
              qaReport,
              (fixedPath) =>
                runClipQa(fixedPath, { ...qaOptsBase, expectedDurationSec: expected - repairPlan.trimmedSec }),
              signal
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
      if (!clipPeaks) {
        clipPeaks = await extractPeaks(inputPath, clip.startSec, clip.endSec).catch(() => undefined);
      }
      // cold-open 让输出时间轴整体后移一个迷你片时长,封面时刻同步平移;
      // qa 修复裁头则整体前移,并钳进修复后的实际时长
      const coverAtRaw =
        pickCoverTime(
          clipPeaks,
          plan ? plan.segments : [{ startSec: clip.startSec, endSec: clip.endSec }],
          clipDuration
        ) + (coldOpenSec ?? 0) - headTrimSec;
      const coverAt = Math.min(Math.max(0.2, coverAtRaw), Math.max(0.2, finalDurationSec - 0.2));
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
        await writeFile(outPath.replace(/\.mp4$/, ".post.txt"), postTextFile(clip.publish), "utf8").catch(() => {});
      }

      results.push({
        id: clip.id,
        title: clip.title,
        path: outPath,
        coverPath: coverOk ? coverPath : undefined,
        sizeBytes: s.size,
        durationSec: finalDurationSec,
        qa: qaReport,
      });
      if (fillerHits.length > 0) {
        removedFillersByClip.set(clip.id, fillerHits.map((h) => h.text.trim()));
      }
      edlClips.push({
        title: clip.title,
        segments: plan ? plan.segments : [{ startSec: clip.startSec, endSec: clip.endSec }],
      });
      const origDur = clip.endSec - clip.startSec;
      renderByClip.set(clip.id, {
        captionStyle: wantCaptions ? (webStyle ?? assStyle) : "none",
        captionsBurned: wantCaptions && !webRenderFailed,
        reframe: audioOnly ? "audiogram" : options.vertical ? (trackPlan ? "face-track" : "center-crop") : "none",
        edit: summarizeEdit(origDur, plan),
        fillersRemoved: fillerHits.length,
        loudnessNormalized: Boolean(options.normalizeLoudness),
        denoised: Boolean(options.denoise),
        coldOpenSec,
        openingHookBurned: Boolean(openingHook),
        translatedLines: transLines.length,
        shotSnap,
      });
      onProgress?.({ current: i + 1, total: totalUnits, clipId: clip.id, stage: "done" });
    }

    // 精华合集:同批切片编码参数一致,流复制拼接秒级完成零画质损失;
    // 合集惯例硬切不加转场;失败静默跳过,绝不拖垮已导出的单条切片
    let compilationFile: string | null = null;
    if (options.compilation && results.length > 1) {
      const compPath = join(outDir, "00-精华合集.mp4");
      const totalSec = results.reduce((a, r) => a + r.durationSec, 0);
      const ok = await concatClips(results.map((r) => r.path), compPath, signal)
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
          buildChapters(results.map((r) => ({ title: r.title, durationSec: r.durationSec }))),
          "utf8"
        ).catch(() => {});
        results.push({
          id: 0,
          title: "精华合集",
          path: compPath,
          sizeBytes: cs?.size ?? 0,
          durationSec: totalSec,
        });
      }
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

    // clips.json: machine-readable evidence chain for CMS / matrix pipelines.
    const metadata = {
      source: inputPath,
      exportedAt: new Date().toISOString(),
      options: {
        vertical: Boolean(options.vertical),
        captionStyle: options.captionStyle ?? "none",
        jumpCut: Boolean(options.jumpCut),
        cleanFillers: Boolean(options.cleanFillers),
        trimUi: Boolean(options.trimUi),
        titleCard: Boolean(options.titleCard),
        openingHook: Boolean(options.openingHook),
        normalizeLoudness: Boolean(options.normalizeLoudness),
        denoise: Boolean(options.denoise),
        coldOpen: Boolean(options.coldOpen),
        compilation: compilationFile,
        snapToShots: Boolean(options.snapToShots),
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
      },
      clips: results.map((r) => {
        const spec = clips.find((c) => c.id === r.id);
        const range = snappedRange.get(r.id);
        return {
          file: basename(r.path),
          cover: r.coverPath ? basename(r.coverPath) : null,
          title: r.title,
          durationSec: Number(r.durationSec.toFixed(3)),
          sourceStartSec: range?.startSec ?? spec?.startSec ?? null,
          sourceEndSec: range?.endSec ?? spec?.endSec ?? null,
          keywords: spec?.keywords ?? [],
          removedFillers: removedFillersByClip.get(r.id) ?? [],
          render: renderByClip.get(r.id) ?? null,
          // 出片质检报告:pass/warn + 告警清单(黑屏/静音/响度/时长/半词)
          qa: r.qa ?? null,
          // 发布文案(标题/话题/简介),同内容也落在 mp4 旁的 .post.txt
          publish: spec?.publish ?? null,
          ...(spec?.meta ?? {}),
        };
      }),
    };
    await writeFile(join(outDir, "clips.json"), JSON.stringify(metadata, null, 2), "utf8").catch(() => {});

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
        { ...options, vertical: false, alsoLandscape: false, faceTrack: false, compilation: false, timeline: false, titleCard: false, openingHook: false },
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
  }
}
