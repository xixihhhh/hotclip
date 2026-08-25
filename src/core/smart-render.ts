/** Conservative video stream-copy eligibility and keyframe probing. */
import { execFile } from "child_process";
import { promisify } from "util";
import { resolveFfprobePath } from "./binaries";
import { buildVideoFilters, type CutOptions } from "./cut";
import type { MediaInfo } from "./probe";

const execFileAsync = promisify(execFile);

interface KeyframeProbeOutput {
  frames?: Array<{
    best_effort_timestamp_time?: string;
    pkt_pts_time?: string;
    pts_time?: string;
  }>;
}

export function parseKeyframeTimestamps(raw: unknown): number[] {
  const frames = Array.isArray((raw as KeyframeProbeOutput | null)?.frames)
    ? (raw as KeyframeProbeOutput).frames!
    : [];
  return frames
    .map((frame) => Number(frame.best_effort_timestamp_time ?? frame.pkt_pts_time ?? frame.pts_time))
    .filter((time) => Number.isFinite(time) && time >= 0)
    .sort((a, b) => a - b);
}

export function keyframeToleranceSec(fps: number): number {
  return Math.max(0.015, fps > 0 ? 0.5 / fps : 0.02);
}

export function isKeyframeAligned(startSec: number, fps: number, keyframes: number[]): boolean {
  if (Math.max(0, startSec) <= keyframeToleranceSec(fps)) return true;
  const tolerance = keyframeToleranceSec(fps);
  return keyframes.some((time) => Math.abs(time - startSec) <= tolerance);
}

/**
 * Only copy H.264 video when the requested start is a proven keyframe and no
 * operation changes pixels. Audio filters do not disqualify this path because
 * audio remains independently filtered and encoded.
 */
export function canCopyVideoStream(
  media: MediaInfo,
  startSec: number,
  options: CutOptions,
  keyframes: number[]
): boolean {
  if (!media.hasVideo || media.videoCodec.toLowerCase() !== "h264") return false;
  if (options.watermark || buildVideoFilters(options).length > 0) return false;
  return isKeyframeAligned(startSec, media.fps, keyframes);
}

/** Probe a narrow window; failures are handled by callers as an encode fallback. */
export async function probeVideoKeyframes(filePath: string, startSec: number): Promise<number[]> {
  if (startSec <= 0) return [0];
  const from = Math.max(0, startSec - 1);
  const duration = 2.5;
  const { stdout } = await execFileAsync(
    resolveFfprobePath(),
    [
      "-v", "error",
      "-select_streams", "v:0",
      "-skip_frame", "nokey",
      "-read_intervals", `${from}%+${duration}`,
      "-show_entries", "frame=best_effort_timestamp_time,pkt_pts_time,pts_time",
      "-of", "json",
      filePath,
    ],
    { maxBuffer: 4 * 1024 * 1024 }
  );
  return parseKeyframeTimestamps(JSON.parse(stdout));
}
