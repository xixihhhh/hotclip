/**
 * Clip export orchestrator: cut every selected highlight out of the source
 * video into ready-to-post mp4s. Pure helpers (naming) + one effectful runner.
 * Optional render passes: 9:16 vertical reframe and burned-in karaoke captions.
 */
import { mkdir, stat, writeFile, rm, mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { cutClip, cutJumpClip } from "./cut";
import { computeJumpCut } from "./gaps";
import { detectUiCrop, type UiCrop } from "./uicrop";
import { buildCaptionAss, VERTICAL_LAYOUT, HORIZONTAL_LAYOUT, type CaptionStyle } from "./subtitle";
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
}

export interface ExportRenderOptions {
  /** Center-crop reframe to 9:16 (1080×1920). */
  vertical?: boolean;
  /** Caption style to burn in (clips must carry `words`); omit for none. */
  captionStyle?: CaptionStyle;
  /** Splice out intra-clip silences (clips must carry `words`). */
  jumpCut?: boolean;
  /** Auto-detect & crop static screen-recording chrome (status bars, app UI). */
  trimUi?: boolean;
  /** Bundled-font directory handed to libass so CJK renders identically everywhere. */
  fontsDir?: string;
}

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
  const assDir = options.captionStyle ? await mkdtemp(join(tmpdir(), "hotclip-ass-")) : null;
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
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      if (signal?.aborted) throw new Error("export cancelled");
      onProgress?.({ current: i + 1, total: clips.length, clipId: clip.id, stage: "cutting" });

      // Jump cut: plan kept segments + words remapped to the output timeline.
      const plan =
        options.jumpCut && clip.words && clip.words.length > 0
          ? computeJumpCut(clip.words, clip.startSec, clip.endSec)
          : null;
      const captionWords = plan ? plan.words : clip.words;
      const captionShift = plan ? 0 : clip.startSec;

      let subtitlePath: string | undefined;
      if (assDir && options.captionStyle && captionWords && captionWords.length > 0) {
        subtitlePath = join(assDir, `clip-${clip.id}.ass`);
        const ass = buildCaptionAss(captionWords, captionShift, layout, options.captionStyle, {
          keywords: clip.keywords,
          forcedBreaks: plan?.breaks,
        });
        await writeFile(subtitlePath, ass, "utf8");
      }

      const outPath = join(outDir, clipFilename(i + 1, clip.title));
      const cutOptions = {
        uiCrop,
        vertical: options.vertical,
        subtitlePath,
        fontsDir: subtitlePath ? options.fontsDir : undefined,
      };
      if (plan && plan.segments.length > 1) {
        await cutJumpClip(inputPath, outPath, clip.startSec, plan.segments, cutOptions);
      } else {
        // single kept segment → plain cut (honoring trimmed lead-in/tail)
        const range = plan?.segments[0] ?? { startSec: clip.startSec, endSec: clip.endSec };
        await cutClip(inputPath, outPath, range.startSec, range.endSec, cutOptions);
      }
      const s = await stat(outPath);
      results.push({
        id: clip.id,
        title: clip.title,
        path: outPath,
        sizeBytes: s.size,
        durationSec: plan ? plan.durationSec : clip.endSec - clip.startSec,
      });
      onProgress?.({ current: i + 1, total: clips.length, clipId: clip.id, stage: "done" });
    }
    return results;
  } finally {
    if (assDir) await rm(assDir, { recursive: true, force: true }).catch(() => {});
  }
}
