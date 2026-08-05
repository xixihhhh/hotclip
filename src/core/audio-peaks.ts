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

/** 一次峰值事件:一段连续的「显著响」区间(笑声/怒吼/掌声的声学代理)。 */
export interface PeakEvent {
  /** 事件内最响一块的时刻(绝对源时间,秒)——打点/运镜强调用它。 */
  atSec: number;
  startSec: number;
  endSec: number;
  /** 事件峰值(0..1)。 */
  peak: number;
}

/** 相邻响块间隔小于该值时并成同一事件(笑声中间的换气不该把事件劈两半)。 */
const EVENT_MERGE_GAP_SEC = 0.35;

/**
 * 从峰值轨提取「峰值事件」:高于全轨最高峰 floorRatio 的块聚类成区间,
 * 按事件峰值从高到低返回前 maxEvents 个。全轨近静音(最高峰 < minPeak)
 * 返回空——没有情绪高点可言。纯函数。
 *
 * 阈值取相对值而非绝对 dB:源素材没归一过响度,绝对阈值在小声素材上会漏、
 * 大声素材上会全命中;「相对本片最响的那一下」才是稳定的情绪峰代理。
 */
export function findPeakEvents(
  track: PeakTrack,
  options: { floorRatio?: number; maxEvents?: number; minPeak?: number } = {}
): PeakEvent[] {
  const { floorRatio = 0.75, maxEvents = 6, minPeak = 0.1 } = options;
  let maxPeak = 0;
  for (const v of track.values) if (v > maxPeak) maxPeak = v;
  if (maxPeak < minPeak) return [];
  const floor = maxPeak * floorRatio;

  const events: PeakEvent[] = [];
  let cur: PeakEvent | null = null;
  for (let i = 0; i < track.values.length; i++) {
    const v = track.values[i];
    const t = track.startSec + i * track.hopSec;
    if (v >= floor) {
      if (cur && t - cur.endSec <= EVENT_MERGE_GAP_SEC) {
        cur.endSec = t + track.hopSec;
        if (v > cur.peak) {
          cur.peak = v;
          cur.atSec = t;
        }
      } else {
        if (cur) events.push(cur);
        cur = { atSec: t, startSec: t, endSec: t + track.hopSec, peak: v };
      }
    }
  }
  if (cur) events.push(cur);
  return events.sort((a, b) => b.peak - a.peak).slice(0, maxEvents);
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
