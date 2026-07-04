/**
 * Clip cutting: extract [start, end] from a source video via ffmpeg.
 * `buildCutArgs` is a pure function (unit-testable); only `cutClip` executes.
 *
 * Two modes:
 *  - "accurate" (default): re-encode with fast seek + output seek trim.
 *    Frame-accurate boundaries — required for hook-first clips where the
 *    first second matters. veryfast x264 keeps a 60s clip under ~10s encode.
 *  - "copy": stream copy. Near-instant but cuts snap to keyframes (can be
 *    seconds off on livestream VODs with sparse keyframes) — preview only.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { resolveFfmpegPath } from "./binaries";
import { toFfmpegTime } from "./time";

const execFileAsync = promisify(execFile);

export type CutMode = "accurate" | "copy";

export interface CutOptions {
  mode?: CutMode;
  /** x264 CRF for accurate mode (lower = better); default 18 (visually lossless-ish). */
  crf?: number;
  /** x264 preset for accurate mode; default "veryfast". */
  preset?: string;
}

/** Build the ffmpeg argument list for one cut. Pure — no I/O. */
export function buildCutArgs(
  inputPath: string,
  outputPath: string,
  startSec: number,
  endSec: number,
  options: CutOptions = {}
): string[] {
  if (!(endSec > startSec)) {
    throw new Error(`invalid cut range: start=${startSec} end=${endSec}`);
  }
  const mode = options.mode ?? "accurate";
  const start = Math.max(0, startSec);
  const duration = endSec - start;

  // Fast seek: -ss BEFORE -i jumps by keyframe index (instant even at hour 3
  // of a VOD); the decoder then trims precisely inside the segment.
  const common = ["-hide_banner", "-y", "-ss", toFfmpegTime(start), "-i", inputPath, "-t", toFfmpegTime(duration)];

  if (mode === "copy") {
    return [...common, "-c", "copy", "-avoid_negative_ts", "make_zero", outputPath];
  }

  const crf = Number.isFinite(options.crf) ? String(options.crf) : "18";
  const preset = options.preset ?? "veryfast";
  return [
    ...common,
    "-c:v", "libx264",
    "-preset", preset,
    "-crf", crf,
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    outputPath,
  ];
}

/** Execute one cut. Throws with ffmpeg's stderr tail on failure. */
export async function cutClip(
  inputPath: string,
  outputPath: string,
  startSec: number,
  endSec: number,
  options: CutOptions = {}
): Promise<void> {
  const args = buildCutArgs(inputPath, outputPath, startSec, endSec, options);
  try {
    await execFileAsync(resolveFfmpegPath(), args, { maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // ffmpeg errors bury the cause at the end of stderr — surface only the tail
    const tail = msg.split("\n").slice(-6).join("\n");
    throw new Error(`ffmpeg cut failed (${toFfmpegTime(startSec)}→${toFfmpegTime(endSec)}): ${tail}`);
  }
}
