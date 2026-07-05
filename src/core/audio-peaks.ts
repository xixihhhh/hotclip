/**
 * Per-block audio peak track — the signal layer under jump-cut decisions.
 * A word gap alone doesn't prove silence: laughter, applause, BGM stings and
 * game SFX carry no words but must survive the cut (auto-editor's insight).
 * Peaks (max |sample| per block) are cheap, and unlike RMS they catch short
 * transients that loudness averaging would smear away.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { resolveFfmpegPath } from "./binaries";

const execFileAsync = promisify(execFile);

const SAMPLE_RATE = 16000;
/** Peak blocks per second; fine enough to bound any 0.12s pad region. */
const BLOCKS_PER_SEC = 30;

export interface PeakTrack {
  /** Normalised peak (0..1) per block. */
  values: Float32Array;
  /** Absolute source time of the first block. */
  startSec: number;
  /** Seconds per block. */
  hopSec: number;
}

/**
 * Fold interleaved s16 PCM into per-block max|sample|/32768. Fractional
 * samples-per-block are handled with error accumulation so block boundaries
 * stay aligned with wall-clock time over long inputs (no drift).
 */
export function peaksFromPcm(samples: Int16Array, samplesPerBlock: number): Float32Array {
  if (samples.length === 0 || samplesPerBlock <= 0) return new Float32Array(0);
  const blocks: number[] = [];
  let acc = 0;
  let i = 0;
  while (i < samples.length) {
    acc += samplesPerBlock;
    const end = Math.min(samples.length, Math.round(acc));
    let peak = 0;
    for (; i < end; i++) {
      const a = Math.abs(samples[i]);
      if (a > peak) peak = a;
    }
    blocks.push(peak / 32768);
    if (end === samples.length) break;
  }
  return Float32Array.from(blocks);
}

/** Max peak within [fromSec, toSec] (absolute source time); 0 when outside. */
export function peakInRange(track: PeakTrack, fromSec: number, toSec: number): number {
  const first = Math.max(0, Math.floor((fromSec - track.startSec) / track.hopSec));
  const last = Math.min(track.values.length - 1, Math.ceil((toSec - track.startSec) / track.hopSec));
  let peak = 0;
  for (let i = first; i <= last; i++) {
    if (track.values[i] > peak) peak = track.values[i];
  }
  return peak;
}

/** Decode [startSec, endSec] to mono 16k PCM and fold into a peak track. */
export async function extractPeaks(
  filePath: string,
  startSec: number,
  endSec: number
): Promise<PeakTrack> {
  const args = [
    "-hide_banner",
    "-ss",
    String(Math.max(0, startSec)),
    "-to",
    String(endSec),
    "-i",
    filePath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    String(SAMPLE_RATE),
    "-f",
    "s16le",
    "-",
  ];
  const { stdout } = await execFileAsync(resolveFfmpegPath(), args, {
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
  });
  const buf = stdout as unknown as Buffer;
  const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
  return {
    values: peaksFromPcm(samples, SAMPLE_RATE / BLOCKS_PER_SEC),
    startSec: Math.max(0, startSec),
    hopSec: 1 / BLOCKS_PER_SEC,
  };
}
