/**
 * Optional learned dialogue enhancement for final publish audio.
 *
 * The model pass runs after edits/cold-open assembly but before HotClip adds
 * SFX/BGM. It is deliberately isolated from the base render: failures keep
 * the clip and fall back to the exact historical FFmpeg denoise chain.
 */
import { execFile } from "child_process";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { resolveFfprobePath } from "./binaries";
import { DENOISE_FILTER, LOUDNORM_FILTER, LOUDNORM_OUT_RATE, runFfmpeg } from "./cut";
import { DPDFNET_SPEECH_ENHANCEMENT_MODEL, ensureModel, modelDir } from "./models";
import { toAnsiSafeDir } from "./win-ansi-path";

const execFileAsync = promisify(execFile);

export type DenoiseMode = "basic" | "smart";
export type AudioEnhancementApplied = "basic" | "learned" | "fallback" | "skipped";

export interface AudioEnhancementReceipt {
  requested: DenoiseMode;
  applied: AudioEnhancementApplied;
  /** Present when the learned model actually ran. */
  modelId?: string;
  sampleRate?: number;
  channels?: number;
  /** Bounded diagnostic only; credentials/paths are never persisted here. */
  reason?: string;
}

interface GeneratedAudio {
  samples: Float32Array;
  sampleRate: number;
}

interface OfflineDenoiser {
  sampleRate: number;
  run(input: { samples: Float32Array; sampleRate: number; enableExternalBuffer?: boolean }): GeneratedAudio;
}

type DenoiserFactory = (modelPath: string) => OfflineDenoiser;

const SAMPLE_RATE = 48_000;
const MAX_CHANNELS = 2;
const MAX_DURATION_SEC = 180;
const CORE_CHUNK_SEC = 30;
const CONTEXT_SEC = 0.5;

/* eslint-disable @typescript-eslint/no-explicit-any */
let sherpa: any = null;
function createDenoiser(modelPath: string): OfflineDenoiser {
  if (!sherpa) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sherpa = require("sherpa-onnx-node");
  }
  return new sherpa.OfflineSpeechDenoiser({
    model: {
      dpdfnet: { model: modelPath },
      numThreads: 1,
      provider: "cpu",
      debug: false,
    },
  }) as OfflineDenoiser;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function boundedReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, " ").trim().slice(0, 180) || "speech enhancement unavailable";
}

/** Clamp arbitrary layouts to the mono/stereo social-output contract. */
export function normalizeEnhancementChannels(value: unknown): 1 | 2 {
  const channels = Number(value);
  return Number.isFinite(channels) && channels <= 1 ? 1 : 2;
}

/** Split interleaved float PCM into one channel without retaining native buffers. */
export function deinterleaveChannel(samples: Float32Array, channels: number, channel: number): Float32Array {
  if (!Number.isInteger(channels) || channels < 1 || channel < 0 || channel >= channels) {
    throw new Error("invalid PCM channel layout");
  }
  const frames = Math.floor(samples.length / channels);
  const out = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) out[frame] = samples[frame * channels + channel];
  return out;
}

/** Write one enhanced channel back into an interleaved destination. */
export function interleaveChannel(
  destination: Float32Array,
  samples: Float32Array,
  channels: number,
  channel: number
): void {
  const frames = Math.min(samples.length, Math.floor(destination.length / channels));
  for (let frame = 0; frame < frames; frame++) destination[frame * channels + channel] = samples[frame];
}

/**
 * Process bounded chunks with left/right context. Only the core of each run is
 * retained, so resetting the offline model never creates a naked boundary.
 */
export function enhancePcmChannel(
  samples: Float32Array,
  denoiser: OfflineDenoiser,
  signal?: AbortSignal
): Float32Array {
  if (denoiser.sampleRate !== SAMPLE_RATE) throw new Error(`speech model output is ${denoiser.sampleRate}Hz, expected ${SAMPLE_RATE}Hz`);
  const core = CORE_CHUNK_SEC * SAMPLE_RATE;
  const context = CONTEXT_SEC * SAMPLE_RATE;
  const output = new Float32Array(samples.length);
  for (let start = 0; start < samples.length; start += core) {
    signal?.throwIfAborted();
    const end = Math.min(samples.length, start + core);
    const windowStart = Math.max(0, start - context);
    const windowEnd = Math.min(samples.length, end + context);
    const generated = denoiser.run({
      samples: samples.subarray(windowStart, windowEnd),
      sampleRate: SAMPLE_RATE,
      enableExternalBuffer: true,
    });
    if (generated.sampleRate !== SAMPLE_RATE) throw new Error(`speech model returned ${generated.sampleRate}Hz audio`);
    const offset = start - windowStart;
    const needed = end - start;
    const available = Math.max(0, Math.min(needed, generated.samples.length - offset));
    const missing = needed - available;
    // DPDFNet works in 10 ms frames and may omit a fractional tail after AAC
    // decode. Preserve that sub-frame tail from the original PCM so the
    // publish timeline stays sample-exact; larger drift is not trusted.
    if (missing > SAMPLE_RATE / 100) {
      throw new Error(`speech model shortened a chunk by ${missing} samples`);
    }
    if (available > 0) output.set(generated.samples.subarray(offset, offset + available), start);
    if (missing > 0) output.set(samples.subarray(start + available, end), start + available);
  }
  signal?.throwIfAborted();
  return output;
}

export function buildPcmExtractArgs(clipPath: string, rawPath: string, channels: 1 | 2): string[] {
  return [
    "-hide_banner", "-y", "-i", clipPath,
    "-map", "0:a:0", "-vn", "-ac", String(channels), "-ar", String(SAMPLE_RATE),
    "-c:a", "pcm_f32le", "-f", "f32le", rawPath,
  ];
}

export function buildEnhancedAudioReplaceArgs(
  clipPath: string,
  rawPath: string,
  outPath: string,
  channels: 1 | 2,
  normalizeLoudness: boolean
): string[] {
  return [
    "-hide_banner", "-y", "-i", clipPath,
    "-f", "f32le", "-ar", String(SAMPLE_RATE), "-ac", String(channels), "-i", rawPath,
    "-map", "0:v:0?", "-map", "1:a:0", "-map_metadata", "0",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    ...(normalizeLoudness ? ["-af", LOUDNORM_FILTER, "-ar", LOUDNORM_OUT_RATE] : ["-af", "alimiter=limit=0.98"]),
    "-movflags", "+faststart", outPath,
  ];
}

export function buildBasicDenoisePostpassArgs(
  clipPath: string,
  outPath: string,
  normalizeLoudness: boolean
): string[] {
  const filter = [DENOISE_FILTER, ...(normalizeLoudness ? [LOUDNORM_FILTER] : [])].join(",");
  return [
    "-hide_banner", "-y", "-i", clipPath,
    "-map", "0:v:0?", "-map", "0:a:0", "-map_metadata", "0",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-af", filter,
    ...(normalizeLoudness ? ["-ar", LOUDNORM_OUT_RATE] : []),
    "-movflags", "+faststart", outPath,
  ];
}

async function probeAudioChannels(clipPath: string): Promise<1 | 2> {
  const { stdout } = await execFileAsync(
    resolveFfprobePath(),
    ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels", "-of", "default=nw=1:nk=1", clipPath],
    { maxBuffer: 1024 * 1024 }
  );
  if (!stdout.trim()) throw new Error("clip has no audio stream");
  return normalizeEnhancementChannels(stdout.trim());
}

async function replaceClipAudio(
  clipPath: string,
  rawPath: string,
  channels: 1 | 2,
  normalizeLoudness: boolean,
  signal?: AbortSignal
): Promise<void> {
  const tmpPath = clipPath.replace(/\.mp4$/i, ".speech.mp4");
  try {
    await runFfmpeg(buildEnhancedAudioReplaceArgs(clipPath, rawPath, tmpPath, channels, normalizeLoudness), { signal });
    await rename(tmpPath, clipPath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Apply the historical fixed filter as a post-render fallback. */
export async function applyBasicDenoisePostpass(
  clipPath: string,
  normalizeLoudness: boolean,
  signal?: AbortSignal
): Promise<void> {
  const tmpPath = clipPath.replace(/\.mp4$/i, ".denoise.mp4");
  try {
    await runFfmpeg(buildBasicDenoisePostpassArgs(clipPath, tmpPath, normalizeLoudness), { signal });
    await rename(tmpPath, clipPath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export interface SmartEnhancementDependencies {
  ensure?: typeof ensureModel;
  factory?: DenoiserFactory;
  probeChannels?: (clipPath: string) => Promise<1 | 2>;
}

/** Run learned 48 kHz enhancement. The input clip is replaced only on success. */
export async function applyLearnedSpeechEnhancement(
  clipPath: string,
  modelsRoot: string,
  normalizeLoudness: boolean,
  signal?: AbortSignal,
  dependencies: SmartEnhancementDependencies = {}
): Promise<AudioEnhancementReceipt> {
  if (!modelsRoot) throw new Error("model storage is unavailable");
  const ensure = dependencies.ensure ?? ensureModel;
  await ensure(modelsRoot, DPDFNET_SPEECH_ENHANCEMENT_MODEL, undefined, signal);
  const safeModelDir = await toAnsiSafeDir(modelDir(modelsRoot, DPDFNET_SPEECH_ENHANCEMENT_MODEL));
  const modelPath = join(safeModelDir, DPDFNET_SPEECH_ENHANCEMENT_MODEL.singleFile!);
  const channels = await (dependencies.probeChannels ?? probeAudioChannels)(clipPath);
  const workDir = await mkdtemp(join(tmpdir(), "hotclip-speech-enhance-"));
  try {
    const inputPath = join(workDir, "input.f32le");
    const outputPath = join(workDir, "output.f32le");
    await runFfmpeg(buildPcmExtractArgs(clipPath, inputPath, channels), { signal });
    const size = (await stat(inputPath)).size;
    const durationSec = size / (Float32Array.BYTES_PER_ELEMENT * channels * SAMPLE_RATE);
    if (!(durationSec > 0)) throw new Error("decoded audio is empty");
    if (durationSec > MAX_DURATION_SEC + 0.05) {
      throw new Error(`smart speech enhancement supports clips up to ${MAX_DURATION_SEC}s`);
    }
    const bytes = await readFile(inputPath);
    const alignedBytes = bytes.byteLength - (bytes.byteLength % Float32Array.BYTES_PER_ELEMENT);
    const storage = new ArrayBuffer(alignedBytes);
    new Uint8Array(storage).set(bytes.subarray(0, alignedBytes));
    const interleaved = new Float32Array(storage);
    const enhanced = new Float32Array(interleaved.length);
    const denoiser = (dependencies.factory ?? createDenoiser)(modelPath);
    for (let channel = 0; channel < channels; channel++) {
      signal?.throwIfAborted();
      const inputChannel = deinterleaveChannel(interleaved, channels, channel);
      interleaveChannel(enhanced, enhancePcmChannel(inputChannel, denoiser, signal), channels, channel);
    }
    await writeFile(outputPath, Buffer.from(enhanced.buffer, enhanced.byteOffset, enhanced.byteLength));
    signal?.throwIfAborted();
    await replaceClipAudio(clipPath, outputPath, channels, normalizeLoudness, signal);
    return {
      requested: "smart",
      applied: "learned",
      modelId: DPDFNET_SPEECH_ENHANCEMENT_MODEL.id,
      sampleRate: SAMPLE_RATE,
      channels,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** Learned mode with an exact legacy-filter fallback and truthful receipt. */
export async function applySmartDenoiseWithFallback(
  clipPath: string,
  modelsRoot: string | undefined,
  normalizeLoudness: boolean,
  signal?: AbortSignal,
  dependencies: SmartEnhancementDependencies = {}
): Promise<AudioEnhancementReceipt> {
  try {
    return await applyLearnedSpeechEnhancement(
      clipPath,
      modelsRoot ?? "",
      normalizeLoudness,
      signal,
      dependencies
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    const learnedReason = boundedReason(error);
    try {
      await applyBasicDenoisePostpass(clipPath, normalizeLoudness, signal);
      return { requested: "smart", applied: "fallback", reason: learnedReason };
    } catch (fallbackError) {
      if (signal?.aborted) throw fallbackError;
      return {
        requested: "smart",
        applied: "skipped",
        reason: boundedReason(`${learnedReason}; basic fallback failed: ${boundedReason(fallbackError)}`),
      };
    }
  }
}
