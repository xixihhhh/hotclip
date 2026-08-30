/** Deterministic final-render cover-frame ranking using bundled FFmpeg metrics. */
import { execFile } from "child_process";
import { promisify } from "util";
import type { PeakTrack } from "./audio-peaks";
import { resolveFfmpegPath } from "./binaries";
import { fallbackCoverTime, pickCoverTime } from "./cover";
import type { KeptSegment } from "./gaps";

const execFileAsync = promisify(execFile);
const MAX_CANDIDATES = 9;
const AUDIO_CANDIDATES = 6;
const MIN_CANDIDATE_GAP_SEC = 0.7;

export interface CoverTimeCandidate {
  atSec: number;
  source: "audio" | "uniform" | "fallback";
  /** Content-relevance prior; final visual evidence still decides. */
  priority: number;
}

export interface CoverFrameMetrics {
  blur: number;
  entropy: number;
  yLow: number;
  yAvg: number;
  yHigh: number;
  satAvg: number;
  yDif: number;
}

export interface CoverSelectionReceipt {
  selectedSec: number;
  fallbackSec: number;
  mode: "quality-ranked" | "fallback";
  candidatesEvaluated: number;
  candidatesRejected: number;
  score?: number;
}

export type CoverMetricProbe = (
  videoPath: string,
  atSec: number,
  signal?: AbortSignal
) => Promise<CoverFrameMetrics | null>;

function clampTime(value: number, durationSec: number): number {
  return Number(Math.min(Math.max(0.2, value), Math.max(0.2, durationSec - 0.2)).toFixed(3));
}

/** Audio peaks propose relevant moments; a uniform reserve prevents signal blind spots. */
export function proposeCoverTimes(
  peaks: PeakTrack | undefined,
  ranges: KeptSegment[],
  durationSec: number
): CoverTimeCandidate[] {
  if (!(durationSec > 0)) return [];
  const proposed: CoverTimeCandidate[] = [];
  const add = (atSec: number, source: CoverTimeCandidate["source"], priority: number): void => {
    const at = clampTime(atSec, durationSec);
    if (proposed.some((item) => Math.abs(item.atSec - at) < MIN_CANDIDATE_GAP_SEC)) return;
    proposed.push({ atSec: at, source, priority });
  };

  for (let rank = 0; rank < AUDIO_CANDIDATES; rank++) {
    add(pickCoverTime(peaks, ranges, durationSec, rank), "audio", Math.max(0.55, 1 - rank * 0.08));
  }
  add(fallbackCoverTime(durationSec), "fallback", 0.5);
  for (const fraction of [0.25, 0.5, 0.75]) add(durationSec * fraction, "uniform", 0.35);
  return proposed.slice(0, MAX_CANDIDATES);
}

/** Parse every complete frame block printed by FFmpeg's metadata filter. */
export function parseCoverMetricFrames(stderr: string): CoverFrameMetrics[] {
  const frames: CoverFrameMetrics[] = [];
  let values: Partial<CoverFrameMetrics> = {};
  const commit = (): void => {
    // blurdetect omits `lavfi.blur` on perfectly flat black/white frames. Keep
    // those frames with a deliberately poor sharpness value so exposure/flat
    // guards can reject them instead of turning the whole candidate into a
    // probe failure.
    const required: Array<keyof CoverFrameMetrics> = ["entropy", "yLow", "yAvg", "yHigh", "satAvg", "yDif"];
    if (required.every((key) => Number.isFinite(values[key]))) {
      frames.push({ ...values, blur: Number.isFinite(values.blur) ? values.blur! : 100 } as CoverFrameMetrics);
    }
    values = {};
  };
  const keys: Array<[RegExp, keyof CoverFrameMetrics]> = [
    [/lavfi\.blur=([\d.eE+-]+)/, "blur"],
    [/lavfi\.entropy\.normalized_entropy\.normal\.Y=([\d.eE+-]+)/, "entropy"],
    [/lavfi\.signalstats\.YLOW=([\d.eE+-]+)/, "yLow"],
    [/lavfi\.signalstats\.YAVG=([\d.eE+-]+)/, "yAvg"],
    [/lavfi\.signalstats\.YHIGH=([\d.eE+-]+)/, "yHigh"],
    [/lavfi\.signalstats\.SATAVG=([\d.eE+-]+)/, "satAvg"],
    [/lavfi\.signalstats\.YDIF=([\d.eE+-]+)/, "yDif"],
  ];
  for (const line of stderr.split(/\r?\n/)) {
    if (/\bframe:\s*\d+\b/.test(line)) commit();
    for (const [pattern, key] of keys) {
      const match = line.match(pattern);
      if (match) values[key] = Number(match[1]);
    }
  }
  commit();
  return frames;
}

function average(frames: CoverFrameMetrics[], key: keyof CoverFrameMetrics): number {
  return frames.reduce((sum, frame) => sum + frame[key], 0) / frames.length;
}

/** Probe a 240 ms neighborhood so a single transition half-frame cannot win. */
export const probeCoverFrameMetrics: CoverMetricProbe = async (videoPath, atSec, signal) => {
  const start = Math.max(0, atSec - 0.12);
  try {
    const { stderr } = await execFileAsync(
      resolveFfmpegPath(),
      [
        "-hide_banner", "-v", "info", "-ss", start.toFixed(3), "-i", videoPath,
        "-t", "0.24", "-an",
        "-vf", [
          "fps=12",
          "scale=640:-2",
          "blurdetect=block_width=32:block_height=32:block_pct=80",
          "entropy",
          "signalstats",
          "metadata=print",
        ].join(","),
        "-f", "null", "-",
      ],
      { maxBuffer: 2 * 1024 * 1024, signal }
    );
    const frames = parseCoverMetricFrames(stderr);
    if (frames.length === 0) return null;
    return {
      blur: average(frames, "blur"),
      entropy: average(frames, "entropy"),
      yLow: average(frames, "yLow"),
      yAvg: average(frames, "yAvg"),
      yHigh: average(frames, "yHigh"),
      satAvg: average(frames, "satAvg"),
      yDif: Math.max(...frames.map((frame) => frame.yDif)),
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
};

function normalized(values: number[], value: number, inverse = false): number {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const result = hi - lo < 1e-6 ? 0.5 : (value - lo) / (hi - lo);
  return inverse ? 1 - result : result;
}

function unsafe(metrics: CoverFrameMetrics): boolean {
  const tonalRange = metrics.yHigh - metrics.yLow;
  return metrics.yAvg < 20 || metrics.yAvg > 235 ||
    (tonalRange < 12 && metrics.entropy < 0.12);
}

/** Rank safe final-output frames; probe failure or no safe candidate preserves old behavior. */
export async function selectQualityCoverTime(opts: {
  videoPath: string;
  candidates: CoverTimeCandidate[];
  fallbackSec: number;
  rank?: number;
  signal?: AbortSignal;
  probe?: CoverMetricProbe;
}): Promise<CoverSelectionReceipt> {
  const probe = opts.probe ?? probeCoverFrameMetrics;
  const evaluated: Array<{ candidate: CoverTimeCandidate; metrics: CoverFrameMetrics }> = [];
  for (const candidate of opts.candidates.slice(0, MAX_CANDIDATES)) {
    opts.signal?.throwIfAborted();
    const metrics = await probe(opts.videoPath, candidate.atSec, opts.signal);
    if (metrics) evaluated.push({ candidate, metrics });
  }
  const fallback = Number(opts.fallbackSec.toFixed(3));
  if (evaluated.length === 0) {
    return { selectedSec: fallback, fallbackSec: fallback, mode: "fallback", candidatesEvaluated: 0, candidatesRejected: 0 };
  }

  const safe = evaluated.filter((item) => !unsafe(item.metrics));
  if (safe.length === 0) {
    return {
      selectedSec: fallback,
      fallbackSec: fallback,
      mode: "fallback",
      candidatesEvaluated: evaluated.length,
      candidatesRejected: evaluated.length,
    };
  }
  const blur = safe.map((item) => item.metrics.blur);
  const range = safe.map((item) => item.metrics.yHigh - item.metrics.yLow);
  const entropy = safe.map((item) => item.metrics.entropy);
  const yDif = safe.map((item) => item.metrics.yDif);
  const ranked = safe.map((item) => {
    const exposure = Math.max(0, 1 - Math.abs(item.metrics.yAvg - 128) / 128);
    const score =
      normalized(blur, item.metrics.blur, true) * 0.28 +
      normalized(range, item.metrics.yHigh - item.metrics.yLow) * 0.18 +
      normalized(entropy, item.metrics.entropy) * 0.12 +
      normalized(yDif, item.metrics.yDif, true) * 0.12 +
      exposure * 0.12 +
      item.candidate.priority * 0.18;
    return { ...item, score };
  }).sort((a, b) => b.score - a.score || a.candidate.atSec - b.candidate.atSec);
  const selected = ranked[Math.min(Math.max(0, opts.rank ?? 0), ranked.length - 1)];
  return {
    selectedSec: selected.candidate.atSec,
    fallbackSec: fallback,
    mode: "quality-ranked",
    candidatesEvaluated: evaluated.length,
    candidatesRejected: evaluated.length - safe.length,
    score: Number(selected.score.toFixed(3)),
  };
}
