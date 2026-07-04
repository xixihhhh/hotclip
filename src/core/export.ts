/**
 * Clip export orchestrator: cut every selected highlight out of the source
 * video into ready-to-post mp4s. Pure helpers (naming) + one effectful runner.
 * Optional render passes: 9:16 vertical reframe and burned-in karaoke captions.
 */
import { mkdir, stat, writeFile, rm, mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { cutClip } from "./cut";
import { buildKaraokeAss, VERTICAL_LAYOUT, HORIZONTAL_LAYOUT } from "./subtitle";
import type { TranscriptWord } from "../shared/api-types";

export interface ExportClipSpec {
  id: number;
  title: string;
  startSec: number;
  endSec: number;
  /** Words the clip covers (absolute source time) — needed for karaoke burn-in. */
  words?: TranscriptWord[];
}

export interface ExportRenderOptions {
  /** Center-crop reframe to 9:16 (1080×1920). */
  vertical?: boolean;
  /** Burn karaoke word-by-word captions (clips must carry `words`). */
  karaoke?: boolean;
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
  const assDir = options.karaoke ? await mkdtemp(join(tmpdir(), "hotclip-ass-")) : null;
  const layout = options.vertical ? VERTICAL_LAYOUT : HORIZONTAL_LAYOUT;

  try {
    const results: ExportedClip[] = [];
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      if (signal?.aborted) throw new Error("export cancelled");
      onProgress?.({ current: i + 1, total: clips.length, clipId: clip.id, stage: "cutting" });

      let subtitlePath: string | undefined;
      if (assDir && clip.words && clip.words.length > 0) {
        subtitlePath = join(assDir, `clip-${clip.id}.ass`);
        await writeFile(subtitlePath, buildKaraokeAss(clip.words, clip.startSec, layout), "utf8");
      }

      const outPath = join(outDir, clipFilename(i + 1, clip.title));
      await cutClip(inputPath, outPath, clip.startSec, clip.endSec, {
        vertical: options.vertical,
        subtitlePath,
      });
      const s = await stat(outPath);
      results.push({
        id: clip.id,
        title: clip.title,
        path: outPath,
        sizeBytes: s.size,
        durationSec: clip.endSec - clip.startSec,
      });
      onProgress?.({ current: i + 1, total: clips.length, clipId: clip.id, stage: "done" });
    }
    return results;
  } finally {
    if (assDir) await rm(assDir, { recursive: true, force: true }).catch(() => {});
  }
}
