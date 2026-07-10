/**
 * Tier-0 audiovisual signals: cheap, fully-local evidence that feeds highlight
 * detection alongside the transcript — loudness peaks (emotional bursts,
 * laughter, shouting) and scene-cut density (visual action). Parsers are pure
 * (unit-testable); ffmpeg execution is isolated in collectSignals.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { resolveFfmpegPath } from "./binaries";

const execFileAsync = promisify(execFile);

export interface TimeRange {
  startSec: number;
  endSec: number;
}

export interface MediaSignals {
  /** Sustained loudness bursts well above the programme's median. */
  loudPeaks: TimeRange[];
  /** Windows with dense scene cuts (fast visual pace). */
  cutDense: TimeRange[];
  /** 端侧视觉模型抽帧圈出的画面高能时段(可选,见 highlight/vision.ts)。 */
  visualPeaks?: TimeRange[];
  /** 表情峰值时段(YuNet+FER+,零配置;可选,见 emotion.ts)。 */
  emotionPeaks?: TimeRange[];
  /** 弹幕热度峰值时段(同名 .xml 自动发现;可选,见 danmaku.ts)。 */
  danmakuPeaks?: TimeRange[];
}

/** Parse `ebur128` stderr lines: "t: 12.5 ... M: -18.2 ..." → [t, M] samples. */
export function parseEbur128(stderr: string): Array<{ t: number; m: number }> {
  const out: Array<{ t: number; m: number }> = [];
  const re = /t:\s*([\d.]+)\s+.*?M:\s*(-?[\d.]+)/g;
  for (const match of stderr.matchAll(re)) {
    const t = Number(match[1]);
    const m = Number(match[2]);
    if (Number.isFinite(t) && Number.isFinite(m) && m > -70) out.push({ t, m });
  }
  return out;
}

/** Parse `showinfo` stderr: pts_time of frames that survived the scene filter. */
export function parseShowinfoTimes(stderr: string): number[] {
  const out: number[] = [];
  for (const match of stderr.matchAll(/pts_time:([\d.]+)/g)) {
    const t = Number(match[1]);
    if (Number.isFinite(t)) out.push(t);
  }
  return out;
}

/** Samples ≥ median+`riseDb` merged into ranges (≥ minDurSec, gap-tolerant). */
export function loudnessPeaks(
  samples: Array<{ t: number; m: number }>,
  riseDb = 6,
  minDurSec = 1.5,
  mergeGapSec = 2
): TimeRange[] {
  if (samples.length < 10) return [];
  const sorted = [...samples].map((s) => s.m).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const threshold = median + riseDb;
  const ranges: TimeRange[] = [];
  let cur: TimeRange | null = null;
  for (const s of samples) {
    if (s.m >= threshold) {
      if (cur && s.t - cur.endSec <= mergeGapSec) cur.endSec = s.t;
      else {
        if (cur) ranges.push(cur);
        cur = { startSec: s.t, endSec: s.t };
      }
    }
  }
  if (cur) ranges.push(cur);
  return ranges.filter((r) => r.endSec - r.startSec >= minDurSec);
}

/** Sliding-window cut density: windows with ≥ minCuts cuts, merged. */
export function cutDensity(cutTimes: number[], windowSec = 15, minCuts = 4): TimeRange[] {
  if (cutTimes.length < minCuts) return [];
  const ranges: TimeRange[] = [];
  let i = 0;
  for (let j = 0; j < cutTimes.length; j++) {
    while (cutTimes[j] - cutTimes[i] > windowSec) i++;
    if (j - i + 1 >= minCuts) {
      const r = { startSec: cutTimes[i], endSec: cutTimes[j] };
      const last = ranges[ranges.length - 1];
      if (last && r.startSec <= last.endSec + windowSec / 2) last.endSec = r.endSec;
      else ranges.push(r);
    }
  }
  return ranges;
}

/** Cap for LLM prompt injection — signals are hints, not the whole story. */
const MAX_RANGES = 12;

/**
 * Run both probes (audio-only + downscaled low-fps video) concurrently.
 * Fail-open: any probe error yields empty signals — detection must not die
 * because a source has no audio/video stream or ffmpeg hiccupped.
 */
export async function collectSignals(inputPath: string): Promise<MediaSignals> {
  const ffmpeg = resolveFfmpegPath();
  const run = (args: string[]): Promise<string> =>
    execFileAsync(ffmpeg, args, { maxBuffer: 128 * 1024 * 1024 }).then(
      (r) => r.stderr,
      () => ""
    );

  const [loudErr, sceneErr] = await Promise.all([
    run(["-hide_banner", "-i", inputPath, "-vn", "-filter_complex", "ebur128", "-f", "null", "-"]),
    run([
      "-hide_banner", "-i", inputPath, "-an",
      "-vf", "fps=4,scale=160:-2,select='gt(scene,0.3)',showinfo",
      "-f", "null", "-",
    ]),
  ]);

  return {
    loudPeaks: loudnessPeaks(parseEbur128(loudErr)).slice(0, MAX_RANGES),
    cutDense: cutDensity(parseShowinfoTimes(sceneErr)).slice(0, MAX_RANGES),
  };
}
