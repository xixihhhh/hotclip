/**
 * Media probing: run ffprobe against a local file and normalize the result.
 * The parse step is a pure function (`parseProbeOutput`) so it stays unit-testable;
 * only `probeMedia` touches the ffprobe binary.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { resolveFfprobePath } from "./binaries";

const execFileAsync = promisify(execFile);

/** Normalized description of an imported media file. */
export interface MediaInfo {
  /** Container duration in seconds (0 when unknown). */
  durationSec: number;
  /** Video stream present? (audio-only podcasts are valid input too) */
  hasVideo: boolean;
  hasAudio: boolean;
  /** Video dimensions; 0 when no video stream. */
  width: number;
  height: number;
  /** Average frame rate, e.g. 29.97; 0 when unknown. */
  fps: number;
  /** Container-level bit rate in bits/s; 0 when unknown. */
  bitRate: number;
  /** First video codec name (e.g. "h264"), empty when none. */
  videoCodec: string;
  /** First audio codec name (e.g. "aac"), empty when none. */
  audioCodec: string;
}

/** Raw ffprobe JSON shape (subset we consume). */
interface FfprobeOutput {
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    duration?: string;
  }>;
  format?: {
    duration?: string;
    bit_rate?: string;
  };
}

/** Parse an "N/D" ffprobe rational (avg_frame_rate) into a float; 0 on bad input. */
export function parseFrameRate(rational: string | undefined): number {
  if (!rational) return 0;
  const [num, den] = rational.split("/").map(Number);
  if (!Number.isFinite(num)) return 0;
  if (den === undefined) return num > 0 ? num : 0;
  if (!Number.isFinite(den) || den === 0) return 0;
  const fps = num / den;
  return fps > 0 ? Math.round(fps * 100) / 100 : 0;
}

/**
 * Normalize raw ffprobe JSON into MediaInfo.
 * Defensive on every field — ffprobe output varies wildly across containers,
 * and a missing field must degrade to a zero value, never a crash.
 */
export function parseProbeOutput(raw: unknown): MediaInfo {
  const data = (raw ?? {}) as FfprobeOutput;
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");

  // Prefer container duration; fall back to the longest stream duration.
  let durationSec = Number(data.format?.duration ?? 0);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    durationSec = Math.max(
      0,
      ...streams.map((s) => {
        const d = Number(s.duration ?? 0);
        return Number.isFinite(d) ? d : 0;
      })
    );
  }

  const bitRate = Number(data.format?.bit_rate ?? 0);

  return {
    durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: Number.isFinite(video?.width) ? (video!.width as number) : 0,
    height: Number.isFinite(video?.height) ? (video!.height as number) : 0,
    fps: parseFrameRate(video?.avg_frame_rate),
    bitRate: Number.isFinite(bitRate) && bitRate > 0 ? bitRate : 0,
    videoCodec: video?.codec_name ?? "",
    audioCodec: audio?.codec_name ?? "",
  };
}

/** Probe a local media file. Throws with an actionable message when ffprobe fails. */
export async function probeMedia(filePath: string): Promise<MediaInfo> {
  const ffprobe = resolveFfprobePath();
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      ffprobe,
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath],
      { maxBuffer: 16 * 1024 * 1024 }
    ));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`ffprobe failed for "${filePath}": ${msg}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`ffprobe returned non-JSON output for "${filePath}"`);
  }
  return parseProbeOutput(parsed);
}
