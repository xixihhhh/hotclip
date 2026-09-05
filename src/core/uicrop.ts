/**
 * Screen-recording UI removal: phone screen captures (livestream rips, app
 * recordings) carry static chrome — status bar, app header, comment/input
 * bars, letterbox bars. Those regions barely change across the video while
 * real content moves, so we detect them as low temporal-variance row bands
 * at the top/bottom and crop them off before the vertical reframe.
 *
 * Detection is conservative: no confident static band → zero crop, so the
 * option is safe to leave on for normal footage.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { resolveFfmpegPath } from "./binaries";
import { ffmpegVideoStreamSpecifier } from "./probe";
import { analysisVideoFilter } from "./analysis-video";
import type { ColorRenderPlan } from "./color";

const execFileAsync = promisify(execFile);

/** Fractions of frame height to crop away (0 = nothing). */
export interface UiCrop {
  topFrac: number;
  bottomFrac: number;
}

/** Analysis frame size (grayscale). Small = fast; rows are what matter. */
const AW = 96;
const AH = 170;
/** How many frames to sample across the video. */
const SAMPLES = 12;
/** A row is "static" when its temporal std is below this gray-level value. */
const STATIC_STD = 2.5;
/** Safety caps — never crop more than this even if the band looks static. */
const MAX_TOP_FRAC = 0.25;
const MAX_BOTTOM_FRAC = 0.32;
/** Ignore bands thinner than this (sensor noise, thin borders). */
const MIN_BAND_FRAC = 0.02;

/**
 * Pure detector: frames are AW×AH grayscale buffers. Returns crop fractions.
 * Exposed for unit tests; production entry is detectUiCrop below.
 */
export function detectStaticBands(frames: Uint8Array[], width = AW, height = AH): UiCrop {
  if (frames.length < 3) return { topFrac: 0, bottomFrac: 0 };
  // temporal std per row (averaged over row pixels)
  const rowStd = new Array<number>(height).fill(0);
  for (let y = 0; y < height; y++) {
    let stdSum = 0;
    for (let x = 0; x < width; x++) {
      let mean = 0;
      for (const f of frames) mean += f[y * width + x];
      mean /= frames.length;
      let varSum = 0;
      for (const f of frames) {
        const d = f[y * width + x] - mean;
        varSum += d * d;
      }
      stdSum += Math.sqrt(varSum / frames.length);
    }
    rowStd[y] = stdSum / width;
  }

  let top = 0;
  while (top < height && rowStd[top] < STATIC_STD) top++;
  let bottom = 0;
  while (bottom < height && rowStd[height - 1 - bottom] < STATIC_STD) bottom++;

  let topFrac = top / height;
  let bottomFrac = bottom / height;
  if (topFrac < MIN_BAND_FRAC) topFrac = 0;
  if (bottomFrac < MIN_BAND_FRAC) bottomFrac = 0;
  return {
    topFrac: Math.min(topFrac, MAX_TOP_FRAC),
    bottomFrac: Math.min(bottomFrac, MAX_BOTTOM_FRAC),
  };
}

/** Sample frames across the source and detect static top/bottom UI bands. */
export async function detectUiCrop(
  inputPath: string,
  durationSec: number,
  videoStreamIndex?: number,
  color?: ColorRenderPlan | null,
  signal?: AbortSignal
): Promise<UiCrop> {
  const fps = SAMPLES / Math.max(1, durationSec);
  const { stdout } = await execFileAsync(
    resolveFfmpegPath(),
    [
      "-hide_banner", "-v", "error",
      "-i", inputPath,
      "-vf", analysisVideoFilter(`fps=${fps.toFixed(6)},scale=${AW}:${AH},format=gray`, color),
      "-map", ffmpegVideoStreamSpecifier(videoStreamIndex),
      "-frames:v", String(SAMPLES),
      "-f", "rawvideo", "-",
    ],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, signal }
  );
  const frameBytes = AW * AH;
  const frames: Uint8Array[] = [];
  for (let off = 0; off + frameBytes <= stdout.length; off += frameBytes) {
    frames.push(new Uint8Array(stdout.subarray(off, off + frameBytes)));
  }
  return detectStaticBands(frames);
}
