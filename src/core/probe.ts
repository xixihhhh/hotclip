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
  /** Selected video codec name (e.g. "h264"), empty when none. */
  videoCodec: string;
  /** ffprobe's global index for the video stream selected by HotClip; -1 when absent. */
  videoStreamIndex?: number;
  /** Selected audio codec name (e.g. "aac"), empty when none. */
  audioCodec: string;
  /** ffprobe's global index for the selected audio stream; -1 when absent. */
  audioStreamIndex?: number;
  /** Selected video pixel format (e.g. "yuv420p10le"); optional for legacy callers. */
  pixelFormat?: string;
  /** Stored video component depth; 0 when ffprobe cannot determine it. */
  bitDepth?: number;
  /** FFmpeg color metadata; empty when absent/unspecified. */
  colorPrimaries?: string;
  colorTransfer?: string;
  colorSpace?: string;
  colorRange?: string;
  /** Static HDR signal peak in nits (MaxCLL preferred, mastering max fallback). */
  hdrPeakNits?: number;
}

interface FfprobeSideData {
  side_data_type?: string;
  max_content?: number | string;
  max_luminance?: number | string;
}

/** Raw ffprobe JSON shape (subset we consume). */
interface FfprobeOutput {
  streams?: Array<{
    index?: number;
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    duration?: string;
    pix_fmt?: string;
    bits_per_raw_sample?: string;
    color_primaries?: string;
    color_transfer?: string;
    color_space?: string;
    color_range?: string;
    disposition?: {
      default?: number;
      attached_pic?: number;
    };
    side_data_list?: FfprobeSideData[];
  }>;
  format?: {
    duration?: string;
    bit_rate?: string;
  };
  frames?: Array<{
    media_type?: string;
    stream_index?: number;
    side_data_list?: FfprobeSideData[];
  }>;
}

type FfprobeStream = NonNullable<FfprobeOutput["streams"]>[number];

function streamIndex(stream: FfprobeStream, fallback: number): number {
  return Number.isInteger(stream.index) && (stream.index ?? -1) >= 0 ? stream.index! : fallback;
}

/**
 * Match HotClip's render selection deterministically instead of relying on
 * FFmpeg's automatic best-stream heuristic (which may choose a different
 * track from ffprobe's first video). Cover-art tracks are never preferred over
 * playable video; within the playable set, the container default wins, then
 * resolution and input order provide a stable fallback.
 */
function selectVideoStream(streams: FfprobeStream[]): { stream: FfprobeStream; index: number } | null {
  const videos = streams
    .map((stream, position) => ({ stream, index: streamIndex(stream, position) }))
    .filter(({ stream }) => stream.codec_type === "video");
  if (videos.length === 0) return null;
  const playable = videos.filter(({ stream }) => stream.disposition?.attached_pic !== 1);
  const candidates = playable.length > 0 ? playable : videos;
  const defaults = candidates.filter(({ stream }) => stream.disposition?.default === 1);
  const ranked = defaults.length > 0 ? defaults : candidates;
  // Prefer the most useful picture when the container did not make one choice
  // unique; equal-area ties retain ffprobe/input order.
  return ranked.reduce((best, candidate) => {
    const bestArea = Math.max(0, best.stream.width ?? 0) * Math.max(0, best.stream.height ?? 0);
    const candidateArea = Math.max(0, candidate.stream.width ?? 0) * Math.max(0, candidate.stream.height ?? 0);
    return candidateArea > bestArea ? candidate : best;
  });
}

function selectAudioStream(streams: FfprobeStream[]): { stream: FfprobeStream; index: number } | null {
  const audios = streams
    .map((stream, position) => ({ stream, index: streamIndex(stream, position) }))
    .filter(({ stream }) => stream.codec_type === "audio");
  return audios.find(({ stream }) => stream.disposition?.default === 1) ?? audios[0] ?? null;
}

/** Explicit FFmpeg input-stream specifier for HotClip's selected video. */
export function ffmpegVideoStreamSpecifier(videoStreamIndex?: number, inputIndex = 0): string {
  return Number.isInteger(videoStreamIndex) && (videoStreamIndex ?? -1) >= 0
    ? `${inputIndex}:${videoStreamIndex}`
    : `${inputIndex}:v:0`;
}

/** Explicit FFmpeg input-stream specifier for HotClip's selected audio. */
export function ffmpegAudioStreamSpecifier(audioStreamIndex?: number, inputIndex = 0, optional = false): string {
  if (Number.isInteger(audioStreamIndex) && (audioStreamIndex ?? -1) >= 0) return `${inputIndex}:${audioStreamIndex}`;
  return `${inputIndex}:a:0${optional ? "?" : ""}`;
}

/** Resolve component depth without guessing from resolution, codec, or HDR tags. */
function parseBitDepth(raw: string | undefined, pixelFormat: string): number {
  const declared = Number(raw ?? 0);
  if (Number.isInteger(declared) && declared > 0) return declared;

  // ffprobe often omits bits_per_raw_sample while retaining it in pix_fmt.
  const packed = pixelFormat.match(/^p0?(9|10|12|14|16)(?:le|be)$/i);
  const planar = pixelFormat.match(/p(9|10|12|14|16)(?:le|be)$/i);
  const inferred = Number(packed?.[1] ?? planar?.[1] ?? 0);
  return Number.isInteger(inferred) && inferred > 0 ? inferred : 0;
}

function parsePositiveNumberOrRatio(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : 0;
  if (typeof value !== "string" || !value.trim()) return 0;
  const [rawNum, rawDen] = value.trim().split("/");
  const num = Number(rawNum);
  const den = rawDen === undefined ? 1 : Number(rawDen);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return 0;
  const result = num / den;
  return Number.isFinite(result) && result > 0 ? result : 0;
}

function parseHdrPeakNits(sideData: FfprobeSideData[] | undefined): number {
  const entries = Array.isArray(sideData) ? sideData : [];
  // MaxCLL describes the encoded content and is more specific than the
  // mastering-display maximum. Both use nits in ffprobe's normalized JSON.
  const maxCll = entries.map((item) => parsePositiveNumberOrRatio(item?.max_content)).find((value) => value > 0) ?? 0;
  const masteringMax = entries.map((item) => parsePositiveNumberOrRatio(item?.max_luminance)).find((value) => value > 0) ?? 0;
  const peak = maxCll || masteringMax;
  if (peak <= 0) return 0;
  return Math.round(Math.min(10_000, Math.max(100, peak)) * 1000) / 1000;
}

/** Parse static HDR peak metadata from either stream or decoded-frame JSON. */
export function parseHdrPeakOutput(raw: unknown, videoStreamIndex?: number): number {
  const data = (raw ?? {}) as FfprobeOutput;
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const frames = Array.isArray(data.frames) ? data.frames : [];
  const selected = Number.isInteger(videoStreamIndex) && (videoStreamIndex ?? -1) >= 0
    ? streams
        .map((stream, position) => ({ stream, index: streamIndex(stream, position) }))
        .find(({ stream, index }) => stream.codec_type === "video" && index === videoStreamIndex)
    : selectVideoStream(streams);
  const video = selected?.stream;
  const framesCarryIndices = frames.some((item) => Number.isInteger(item.stream_index));
  const frame = Number.isInteger(videoStreamIndex) && (videoStreamIndex ?? -1) >= 0
    ? frames.find((item) => item.media_type === "video" && item.stream_index === videoStreamIndex)
      ?? (!framesCarryIndices ? frames.find((item) => item.media_type === "video") ?? frames[0] : undefined)
    : frames.find((item) => item.media_type === "video") ?? frames[0];
  return parseHdrPeakNits([...(video?.side_data_list ?? []), ...(frame?.side_data_list ?? [])]);
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
  const selectedVideo = selectVideoStream(streams);
  const video = selectedVideo?.stream;
  const selectedAudio = selectAudioStream(streams);
  const audio = selectedAudio?.stream;

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
  const pixelFormat = typeof video?.pix_fmt === "string" ? video.pix_fmt : "";

  return {
    durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: Number.isFinite(video?.width) ? (video!.width as number) : 0,
    height: Number.isFinite(video?.height) ? (video!.height as number) : 0,
    fps: parseFrameRate(video?.avg_frame_rate),
    bitRate: Number.isFinite(bitRate) && bitRate > 0 ? bitRate : 0,
    videoCodec: video?.codec_name ?? "",
    videoStreamIndex: selectedVideo?.index ?? -1,
    audioCodec: audio?.codec_name ?? "",
    audioStreamIndex: selectedAudio?.index ?? -1,
    pixelFormat,
    bitDepth: parseBitDepth(video?.bits_per_raw_sample, pixelFormat),
    colorPrimaries: typeof video?.color_primaries === "string" ? video.color_primaries : "",
    colorTransfer: typeof video?.color_transfer === "string" ? video.color_transfer : "",
    colorSpace: typeof video?.color_space === "string" ? video.color_space : "",
    colorRange: typeof video?.color_range === "string" ? video.color_range : "",
    hdrPeakNits: parseHdrPeakOutput(data, selectedVideo?.index),
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
  const info = parseProbeOutput(parsed);
  // ffprobe 5.x commonly exposes HDR10 mastering/MaxCLL data on the first
  // decoded frame rather than the stream. Decode at most one frame and only
  // for an HDR transfer whose stream metadata did not already provide a peak.
  if (
    (info.colorTransfer === "smpte2084" || info.colorTransfer === "arib-std-b67") &&
    !(info.hdrPeakNits && info.hdrPeakNits > 0)
  ) {
    try {
      const frame = await execFileAsync(
        ffprobe,
        ["-v", "error", "-select_streams", String(info.videoStreamIndex), "-read_intervals", "%+#1", "-show_frames", "-print_format", "json", filePath],
        { maxBuffer: 4 * 1024 * 1024 }
      );
      const peak = parseHdrPeakOutput(JSON.parse(frame.stdout), info.videoStreamIndex);
      if (peak > 0) info.hdrPeakNits = peak;
    } catch {
      // Peak metadata is optional; tone-map retains FFmpeg's bounded fallback.
    }
  }
  return info;
}
