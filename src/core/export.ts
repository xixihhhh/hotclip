/**
 * Clip export orchestrator: cut every selected highlight out of the source
 * video into ready-to-post mp4s. Pure helpers (naming) + one effectful runner.
 * Optional render passes: 9:16 vertical reframe and burned-in karaoke captions.
 */
import { mkdir, stat, writeFile, rm, mkdtemp } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { tmpdir } from "os";
import { join, basename } from "path";
import { resolveFfmpegPath } from "./binaries";

const execFileAsync = promisify(execFile);
import { cutClip, cutJumpClip } from "./cut";
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
}

export interface ExportedClip {
  id: number;
  title: string;
  path: string;
  /** Cover JPG next to the clip (frame from just after the hook). */
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
      onProgress?.({ current: i + 1, total: clips.length, clipId: clip.id, stage: "cutting" });

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
          onProgress?.({ current: i + 1, total: clips.length, clipId: clip.id, stage: "cutting", fraction });
        }
      };

      // AIGC 隐式标识:内容属性 + 服务者 + 内容编号写进容器元数据(《标识办法》)
      const aigcMeta = options.aigcLabel
        ? { comment: `AIGC=true; Label=AI-assisted-editing; Tool=HotClip; ContentId=${basename(outPath)}` }
        : undefined;
      const cutOptions = trackPlan
        ? { trackPlan, subtitlePath, fontsDir: subtitlePath ? options.fontsDir : undefined, normalizeLoudness: options.normalizeLoudness, watermark, metadata: aigcMeta }
        : {
            uiCrop,
            vertical: options.vertical,
            subtitlePath,
            fontsDir: subtitlePath ? options.fontsDir : undefined,
            normalizeLoudness: options.normalizeLoudness,
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
      const s = await stat(outPath);

      // Cover: a frame just after the hook lands, pulled from the FINISHED
      // clip so captions/title plate are baked in — platform-upload ready.
      const coverPath = outPath.replace(/\.mp4$/, ".jpg");
      // 智能封面:切片内响度最高的一帧(峰值≈情绪最高点);没跳剪时补提一次
      // 峰值轨,失败回退固定 0.8s 帧
      if (!clipPeaks) {
        clipPeaks = await extractPeaks(inputPath, clip.startSec, clip.endSec).catch(() => undefined);
      }
      const coverAt = pickCoverTime(
        clipPeaks,
        plan ? plan.segments : [{ startSec: clip.startSec, endSec: clip.endSec }],
        clipDuration
      );
      const coverOk = await execFileAsync(
        resolveFfmpegPath(),
        ["-hide_banner", "-v", "error", "-ss", coverAt.toFixed(2), "-i", outPath, "-frames:v", "1", "-q:v", "2", "-y", coverPath],
        { maxBuffer: 8 * 1024 * 1024 }
      ).then(() => true, () => false);

      // SRT 字幕文件:与烧录字幕同一套词/断行/时间基(跳剪重映射后),
      // 平台原生字幕上传与二次精修用
      if (options.subtitleFile && wantCaptions) {
        const relWords = captionWords!.map((w) => ({
          text: w.text,
          startSec: w.startSec - captionShift,
          endSec: w.endSec - captionShift,
        }));
        const relTrans = transLines.map((l) => ({
          startSec: l.startSec - captionShift,
          endSec: l.endSec - captionShift,
          text: l.text,
        }));
        const srt = buildSrt(srtLinesFromWords(relWords, plan?.breaks ?? [], relTrans));
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
        durationSec: clipDuration,
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
        openingHookBurned: Boolean(openingHook),
        translatedLines: transLines.length,
        shotSnap,
      });
      onProgress?.({ current: i + 1, total: clips.length, clipId: clip.id, stage: "done" });
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
        snapToShots: Boolean(options.snapToShots),
        // 双语字幕回执:目标语言;实际每条烧了几行见 clips[].render.translatedLines
        translateLang: options.translateLang ?? null,
        subtitleFile: Boolean(options.subtitleFile),
        timeline: Boolean(options.timeline),
        aigcLabel: Boolean(options.aigcLabel),
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
          // 发布文案(标题/话题/简介),同内容也落在 mp4 旁的 .post.txt
          publish: spec?.publish ?? null,
          ...(spec?.meta ?? {}),
        };
      }),
    };
    await writeFile(join(outDir, "clips.json"), JSON.stringify(metadata, null, 2), "utf8").catch(() => {});

    return results;
  } finally {
    if (assDir) await rm(assDir, { recursive: true, force: true }).catch(() => {});
  }
}
