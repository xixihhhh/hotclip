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
import { findFillerWords, dropFillerWords, fillerCutSpans, type FillerHit } from "./fillers";
import { extractPeaks } from "./audio-peaks";
import { detectUiCrop, type UiCrop } from "./uicrop";
import { generateCropPlan, renderCropXExpr, mapToOutputTime } from "./reframe";
import { detectShotBoundaries, snapClipToShots, SNAP_MAX_OUT_SEC } from "./shots";
import { buildCaptionAss, VERTICAL_LAYOUT, HORIZONTAL_LAYOUT, type CaptionStyle } from "./subtitle";
import { buildOverlayPayload, isWebCaptionStyle, type OverlayRenderFn, type WebCaptionStyle } from "./caption-overlay/payload";
import { probeMedia } from "./probe";
import type { TranscriptWord } from "../shared/api-types";

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
  /** "face-track" when the crop followed a face, "center-crop" on fallback, "none" for horizontal. */
  reframe: "face-track" | "center-crop" | "none";
  /** Jump-cut / filler splice outcome; null when the clip was cut whole. */
  edit: { splices: number; keptSec: number; removedSec: number; cutRatio: number } | null;
  /** Number of filler/stutter words removed. */
  fillersRemoved: number;
  /** True when audio was matched to the -14 LUFS social loudness target. */
  loudnessNormalized: boolean;
  /** True when the AI teaser was burned in as an opening hook. */
  openingHookBurned: boolean;
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
  const needAss = Boolean(options.captionStyle) || Boolean(options.titleCard) || Boolean(options.openingHook);
  const assDir = needAss ? await mkdtemp(join(tmpdir(), "hotclip-ass-")) : null;
  const layout = options.vertical ? VERTICAL_LAYOUT : HORIZONTAL_LAYOUT;

  // one UI-chrome detection pass for the whole source (bands don't move)
  let uiCrop: UiCrop | undefined;
  if (options.trimUi && clips.length > 0) {
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
    for (let i = 0; i < clips.length; i++) {
      let clip = clips[i];
      if (signal?.aborted) throw new Error("export cancelled");
      onProgress?.({ current: i + 1, total: clips.length, clipId: clip.id, stage: "cutting" });

      // 切点吸附:起止点吸到最近的镜头边界(词边界守卫,检测失败回退不吸附)。
      // 必须在跳剪/字幕/取景之前调整——下游全部消费 clip.startSec/endSec。
      let shotSnap: ClipRenderOutcome["shotSnap"] = null;
      if (options.snapToShots && options.modelsRoot && !clip.manualBounds) {
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
      if ((options.jumpCut || options.cleanFillers) && clip.words && clip.words.length > 0) {
        fillerHits = options.cleanFillers ? findFillerWords(clip.words) : [];
        const planWords = dropFillerWords(clip.words, fillerHits);
        const peaks = options.jumpCut
          ? await extractPeaks(inputPath, clip.startSec, clip.endSec).catch(() => undefined)
          : undefined;
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
      if (assDir && needAss && ((wantCaptions && !webStyle) || options.titleCard || openingHook)) {
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
          }
        );
        await writeFile(subtitlePath, ass, "utf8");
      }

      // Face-aware reframe: plan per clip; any failure falls back to center.
      let trackPlan;
      if (options.vertical && options.faceTrack && options.modelsRoot) {
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
      const cutOptions = trackPlan
        ? { trackPlan, subtitlePath, fontsDir: subtitlePath ? options.fontsDir : undefined, normalizeLoudness: options.normalizeLoudness }
        : {
            uiCrop,
            vertical: options.vertical,
            subtitlePath,
            fontsDir: subtitlePath ? options.fontsDir : undefined,
            normalizeLoudness: options.normalizeLoudness,
          };
      if (plan && plan.segments.length > 1) {
        await cutJumpClip(inputPath, cutTarget, clip.startSec, plan.segments, cutOptions);
      } else {
        // single kept segment → plain cut (honoring trimmed lead-in/tail)
        const range = plan?.segments[0] ?? { startSec: clip.startSec, endSec: clip.endSec };
        await cutClip(inputPath, cutTarget, range.startSec, range.endSec, cutOptions);
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
      const coverAt = Math.min(0.8, Math.max(0, clipDuration - 0.1));
      const coverOk = await execFileAsync(
        resolveFfmpegPath(),
        ["-hide_banner", "-v", "error", "-ss", coverAt.toFixed(2), "-i", outPath, "-frames:v", "1", "-q:v", "2", "-y", coverPath],
        { maxBuffer: 8 * 1024 * 1024 }
      ).then(() => true, () => false);

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
      const origDur = clip.endSec - clip.startSec;
      renderByClip.set(clip.id, {
        captionStyle: wantCaptions ? (webStyle ?? assStyle) : "none",
        captionsBurned: wantCaptions && !webRenderFailed,
        reframe: options.vertical ? (trackPlan ? "face-track" : "center-crop") : "none",
        edit: summarizeEdit(origDur, plan),
        fillersRemoved: fillerHits.length,
        loudnessNormalized: Boolean(options.normalizeLoudness),
        openingHookBurned: Boolean(openingHook),
        shotSnap,
      });
      onProgress?.({ current: i + 1, total: clips.length, clipId: clip.id, stage: "done" });
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
