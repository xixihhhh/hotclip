/** ffmpeg H.264 encoder selection with a software fallback in the cut layer. */
import { execFile } from "child_process";
import { promisify } from "util";
import { resolveFfmpegPath } from "./binaries";

const execFileAsync = promisify(execFile);

export type VideoEncoder = "libx264" | "h264_videotoolbox" | "h264_nvenc" | "h264_qsv";

export function encoderCandidates(platform: NodeJS.Platform): VideoEncoder[] {
  if (platform === "darwin") return ["h264_videotoolbox", "libx264"];
  if (platform === "win32") return ["h264_nvenc", "h264_qsv", "libx264"];
  return ["h264_nvenc", "h264_qsv", "libx264"];
}

export function pickVideoEncoder(encoderOutput: string, platform: NodeJS.Platform = process.platform): VideoEncoder {
  for (const name of encoderCandidates(platform)) {
    if (name === "libx264" || new RegExp(`\\b${name}\\b`).test(encoderOutput)) return name;
  }
  return "libx264";
}

let cached: Promise<VideoEncoder> | null = null;

/** Probe once per process. Failure means software encoding, never export failure. */
export function resolveVideoEncoder(): Promise<VideoEncoder> {
  if (!cached) {
    cached = execFileAsync(resolveFfmpegPath(), ["-hide_banner", "-encoders"], { maxBuffer: 4 * 1024 * 1024 })
      .then(({ stdout, stderr }) => pickVideoEncoder(`${stdout}\n${stderr}`))
      .catch(() => "libx264" as const);
  }
  return cached;
}

/** Map x264-style quality onto the nearest option supported by each encoder. */
export function videoEncoderArgs(encoder: VideoEncoder, crf = 18, preset = "veryfast"): string[] {
  const quality = Math.max(0, Math.min(51, Math.round(crf)));
  if (encoder === "h264_videotoolbox") {
    return ["-c:v", encoder, "-q:v", String(Math.max(1, Math.min(100, 100 - quality * 2))), "-allow_sw", "0"];
  }
  if (encoder === "h264_nvenc") {
    return ["-c:v", encoder, "-preset", "p4", "-tune", "hq", "-rc", "vbr", "-cq", String(quality), "-b:v", "0"];
  }
  if (encoder === "h264_qsv") {
    return ["-c:v", encoder, "-preset", "veryfast", "-global_quality", String(quality)];
  }
  return ["-c:v", "libx264", "-preset", preset, "-crf", String(quality)];
}
