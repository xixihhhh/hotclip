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
  /** Reframe to 9:16 vertical (center crop → 1080×1920). Requires re-encode. */
  vertical?: boolean;
  /** Burn an .ass karaoke subtitle file via libass. Requires re-encode. */
  subtitlePath?: string;
  /** Directory holding bundled fonts for libass (subtitles filter fontsdir). */
  fontsDir?: string;
}

/**
 * ffmpeg filter-graph path escaping for the subtitles filter: forward slashes
 * everywhere, escape the Windows drive colon, guard stray quotes.
 */
export function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

/** Compose the -vf chain for reframing + caption burn-in. Empty = no filter. */
export function buildVideoFilters(options: CutOptions): string[] {
  const filters: string[] = [];
  if (options.vertical) {
    // Center crop to exactly 9:16 (whichever axis binds), then normalize size.
    filters.push("crop=w='min(iw,ih*9/16)':h='min(ih,iw*16/9)'", "scale=1080:1920:flags=lanczos", "setsar=1");
  }
  if (options.subtitlePath) {
    const fonts = options.fontsDir ? `:fontsdir='${escapeFilterPath(options.fontsDir)}'` : "";
    filters.push(`subtitles=filename='${escapeFilterPath(options.subtitlePath)}'${fonts}`);
  }
  return filters;
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
  const filters = buildVideoFilters(options);
  // Any video filter forces a re-encode — silently upgrade copy → accurate.
  const mode = filters.length > 0 ? "accurate" : (options.mode ?? "accurate");
  const start = Math.max(0, startSec);
  const duration = endSec - start;

  // Fast seek: -ss BEFORE -i jumps by keyframe index (instant even at hour 3
  // of a VOD); the decoder then trims precisely inside the segment. Input
  // seeking also resets PTS to ~0, which is exactly what the clip-relative
  // ASS karaoke timestamps assume.
  const common = ["-hide_banner", "-y", "-ss", toFfmpegTime(start), "-i", inputPath, "-t", toFfmpegTime(duration)];

  if (mode === "copy") {
    return [...common, "-c", "copy", "-avoid_negative_ts", "make_zero", outputPath];
  }

  const crf = Number.isFinite(options.crf) ? String(options.crf) : "18";
  const preset = options.preset ?? "veryfast";
  return [
    ...common,
    ...(filters.length > 0 ? ["-vf", filters.join(",")] : []),
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

/**
 * Jump-cut arg builder: keep only `segments` (absolute source time) of one
 * clip and splice them in a single filter_complex pass — trim/atrim → concat
 * → optional reframe + caption burn-in. Fast seek still applies: we seek to
 * the clip start and express segment times relative to the seek point.
 */
export function buildJumpCutArgs(
  inputPath: string,
  outputPath: string,
  clipStartSec: number,
  segments: Array<{ startSec: number; endSec: number }>,
  options: CutOptions = {}
): string[] {
  if (segments.length === 0) throw new Error("jump cut requires at least one segment");
  const seek = Math.max(0, clipStartSec);
  const lastEnd = segments[segments.length - 1].endSec;
  const readDuration = lastEnd - seek + 0.5; // small margin past the tail

  const parts: string[] = [];
  const labels: string[] = [];
  segments.forEach((s, i) => {
    const a = Math.max(0, s.startSec - seek);
    const b = Math.max(a, s.endSec - seek);
    parts.push(`[0:v]trim=start=${a.toFixed(3)}:end=${b.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
    parts.push(`[0:a]atrim=start=${a.toFixed(3)}:end=${b.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
    labels.push(`[v${i}][a${i}]`);
  });
  const post = buildVideoFilters(options);
  const concatOut = post.length > 0 ? "[vc]" : "[vout]";
  parts.push(`${labels.join("")}concat=n=${segments.length}:v=1:a=1${concatOut}[aout]`);
  if (post.length > 0) parts.push(`[vc]${post.join(",")}[vout]`);

  const crf = Number.isFinite(options.crf) ? String(options.crf) : "18";
  const preset = options.preset ?? "veryfast";
  return [
    "-hide_banner", "-y",
    "-ss", toFfmpegTime(seek),
    "-i", inputPath,
    "-t", toFfmpegTime(readDuration),
    "-filter_complex", parts.join(";"),
    "-map", "[vout]",
    "-map", "[aout]",
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

/** Execute a jump cut. Throws with ffmpeg's stderr tail on failure. */
export async function cutJumpClip(
  inputPath: string,
  outputPath: string,
  clipStartSec: number,
  segments: Array<{ startSec: number; endSec: number }>,
  options: CutOptions = {}
): Promise<void> {
  const args = buildJumpCutArgs(inputPath, outputPath, clipStartSec, segments, options);
  try {
    await execFileAsync(resolveFfmpegPath(), args, { maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const tail = msg.split("\n").slice(-6).join("\n");
    throw new Error(`ffmpeg jump cut failed (${segments.length} segments): ${tail}`);
  }
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
