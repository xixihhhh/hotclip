/**
 * Tier-0 audiovisual signals: cheap, fully-local evidence that feeds highlight
 * detection alongside the transcript — loudness peaks (emotional bursts,
 * laughter, shouting) and scene-cut density (visual action). Parsers are pure
 * (unit-testable); ffmpeg execution is isolated in collectSignals.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { resolveFfmpegPath } from "./binaries";
import { analysisVideoFilter, type AnalysisVideoOptions } from "./analysis-video";
import { ffmpegVideoStreamSpecifier } from "./probe";
import {
  compactVisualSignalSamples,
  parseVisualSignalSamples,
  type VisualSignalSample,
} from "./visual-enhance";

const execFileAsync = promisify(execFile);

export interface TimeRange {
  startSec: number;
  endSec: number;
}

export interface MotionSample {
  t: number;
  /** Low-resolution frame-difference score, 0..1. */
  score: number;
}

export interface MediaSignals {
  /** Sustained loudness bursts well above the programme's median. */
  loudPeaks: TimeRange[];
  /** Windows with dense scene cuts (fast visual pace). */
  cutDense: TimeRange[];
  /** Sustained low-resolution frame-difference activity (movement/action, not semantic understanding). */
  motionPeaks?: TimeRange[];
  /** One max frame-difference value per source second, retained for reuse/evaluation. */
  motionSamples?: MotionSample[];
  /** Strong, well-spaced source timestamps that can guide later visual sampling. */
  activityKeyframes?: MotionSample[];
  /** Compact per-second luma/saturation evidence for opt-in adaptive finishing. */
  visualSamples?: VisualSignalSample[];
  /**
   * ebur128 原始采样(t + momentary dB)。采集时顺手保留——工作台时间轴要画
   * 全场响度曲线,不留的话同一条 2 小时音轨得再解码一遍。仅主进程内使用,
   * 不进提示词也不进渲染层(时间轴 IPC 会把它压成每格一个值再发)。
   */
  loudnessSamples?: Array<{ t: number; m: number }>;
  /** 端侧视觉模型抽帧圈出的画面高能时段(可选,见 highlight/vision.ts)。 */
  visualPeaks?: TimeRange[];
  /** 表情峰值时段(YuNet+FER+,零配置;可选,见 emotion.ts)。 */
  emotionPeaks?: TimeRange[];
  /** 语音情绪激动时段(SenseVoice 情绪标签短窗重扫;可选,见 voice-emotion.ts)。 */
  voiceEmotionPeaks?: TimeRange[];
  /** 笑声/掌声/哭腔时段(SenseVoice 音频事件标签;可选,见 voice-emotion.ts)。 */
  audioEventPeaks?: TimeRange[];
  /** 弹幕热度峰值时段(同名 .xml 自动发现;可选,见 danmaku.ts)。 */
  danmakuPeaks?: TimeRange[];
  /** 主播剪辑口令时刻(「这段剪下来/clip that」——主播自证的爆点,内容在口令之前;见 highlight/commands.ts)。 */
  clipCommandMarks?: number[];
  /** 全场扫描的画面时刻线;visibleText 只收画面中可逐字确认的短文字,不收推断。 */
  visualNotes?: Array<{ t: number; energy: number; note: string; visibleText?: string[] }>;
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

/** Parse FFmpeg metadata=print pairs containing pts_time and lavfi.scene_score. */
export function parseSceneScoreSamples(stderr: string): MotionSample[] {
  const out: MotionSample[] = [];
  let pendingTime: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const time = line.match(/\bpts_time:([\d.]+)/);
    if (time) {
      const value = Number(time[1]);
      pendingTime = Number.isFinite(value) ? value : null;
    }
    const score = line.match(/lavfi\.scene_score=([\d.eE+-]+)/);
    if (score && pendingTime !== null) {
      const value = Number(score[1]);
      if (Number.isFinite(value)) out.push({ t: pendingTime, score: Math.max(0, Math.min(1, value)) });
      pendingTime = null;
    }
  }
  return out;
}

/** Keep a compact, deterministic max activity sample for each source second. */
export function compactMotionSamples(samples: MotionSample[]): MotionSample[] {
  const bins = new Map<number, MotionSample>();
  for (const sample of samples) {
    if (!Number.isFinite(sample.t) || !Number.isFinite(sample.score) || sample.t < 0) continue;
    const second = Math.floor(sample.t);
    const current = bins.get(second);
    if (!current || sample.score > current.score) bins.set(second, sample);
  }
  return [...bins.values()]
    .sort((a, b) => a.t - b.t)
    .map((sample) => ({ t: Number(sample.t.toFixed(3)), score: Number(sample.score.toFixed(5)) }));
}

/** High frame-difference samples become short activity ranges, ranked then capped. */
export function motionPeakRanges(samples: MotionSample[], durationSec: number, maxRanges = 12): TimeRange[] {
  const usable = samples.filter((sample) => Number.isFinite(sample.score) && sample.score > 0);
  if (usable.length < 8 || !(durationSec > 0)) return [];
  const scores = usable.map((sample) => sample.score).sort((a, b) => a - b);
  const threshold = Math.max(0.012, scores[Math.floor(scores.length * 0.85)] ?? 0);
  const hits = usable
    .filter((sample) => sample.score >= threshold)
    .map((sample) => ({ startSec: Math.max(0, sample.t - 1), endSec: Math.min(durationSec, sample.t + 1), score: sample.score }))
    .sort((a, b) => a.startSec - b.startSec);
  const merged: Array<TimeRange & { score: number }> = [];
  for (const hit of hits) {
    const last = merged[merged.length - 1];
    if (last && hit.startSec <= last.endSec + 1.5) {
      last.endSec = Math.max(last.endSec, hit.endSec);
      last.score = Math.max(last.score, hit.score);
    } else merged.push({ ...hit });
  }
  return merged
    .sort((a, b) => b.score - a.score || a.startSec - b.startSec)
    .slice(0, Math.max(0, maxRanges))
    .sort((a, b) => a.startSec - b.startSec)
    .map(({ startSec, endSec }) => ({ startSec: Number(startSec.toFixed(3)), endSec: Number(endSec.toFixed(3)) }));
}

/** Strong, separated timestamps for contact-sheet/VLM sampling; no image bytes are persisted. */
export function activityKeyframes(samples: MotionSample[], maxFrames = 48, minSpacingSec = 8): MotionSample[] {
  const scores = samples.map((sample) => sample.score).filter((score) => Number.isFinite(score) && score > 0).sort((a, b) => a - b);
  if (scores.length < 8) return [];
  const threshold = Math.max(0.012, scores[Math.floor(scores.length * 0.85)] ?? 0);
  const picked: MotionSample[] = [];
  for (const sample of [...samples].sort((a, b) => b.score - a.score || a.t - b.t)) {
    if (sample.score < threshold || picked.some((item) => Math.abs(item.t - sample.t) < minSpacingSec)) continue;
    picked.push({ t: Number(sample.t.toFixed(3)), score: Number(sample.score.toFixed(5)) });
    if (picked.length >= maxFrames) break;
  }
  return picked.sort((a, b) => a.t - b.t);
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
 * 信号引导的采样规划:在已知的高能窗口(响度峰值/镜头密集段/弹幕峰值)内
 * 按步长密集采样,再用均匀网格铺满剩余额度防信号盲区漏段,全程保持最小
 * 间隔。二级信号采集(抽帧表情、短窗语音情绪)共用——把有限的推理预算
 * 花在最可能有爆点的地方;弹幕峰值是观众逐秒投的票,笑声/表情最该去
 * 那里找,所以弹幕要先于贵信号采集(它只是读个文件)。纯函数。
 */
export function planSignalGuidedTimes(
  durationSec: number,
  signals: MediaSignals | undefined,
  maxCount: number,
  minSpacingSec: number,
  windowStepSec: number,
  edgePadSec = 0.5
): number[] {
  if (!(durationSec > 1) || maxCount < 1) return [];
  const lo = Math.min(edgePadSec, durationSec / 2);
  const hi = Math.max(lo, durationSec - edgePadSec);
  const clamp = (t: number): number => Math.min(hi, Math.max(lo, t));
  const picked: number[] = [];
  const fits = (t: number): boolean => picked.every((p) => Math.abs(p - t) >= minSpacingSec);
  const tryPick = (t: number): void => {
    const c = clamp(t);
    if (picked.length < maxCount && fits(c)) picked.push(c);
  };
  // 信号窗口内步进采样(爆点就藏在响度峰值/镜头密集段/弹幕峰值里)
  const windows = [
    ...(signals?.loudPeaks ?? []),
    ...(signals?.cutDense ?? []),
    ...(signals?.danmakuPeaks ?? []),
  ].sort((a, b) => a.startSec - b.startSec);
  for (const w of windows) {
    for (let t = w.startSec; t <= w.endSec; t += windowStepSec) tryPick(t);
  }
  // 均匀网格兜底,防信号盲区整段漏掉
  for (let i = 1; i <= maxCount; i++) tryPick((durationSec * i) / (maxCount + 1));
  return picked.sort((a, b) => a - b);
}

/**
 * Run both probes (audio-only + downscaled low-fps video) concurrently.
 * Fail-open: any probe error yields empty signals — detection must not die
 * because a source has no audio/video stream or ffmpeg hiccupped.
 */
export async function collectSignals(
  inputPath: string,
  signal?: AbortSignal,
  analysis: AnalysisVideoOptions = {}
): Promise<MediaSignals> {
  const ffmpeg = resolveFfmpegPath();
  const run = (args: string[]): Promise<string> =>
    execFileAsync(ffmpeg, args, { maxBuffer: 128 * 1024 * 1024, signal }).then(
      (r) => r.stderr,
      (error) => {
        if (signal?.aborted) throw error;
        return "";
      }
    );

  const [loudErr, sceneErr] = await Promise.all([
    run(["-hide_banner", "-i", inputPath, "-vn", "-filter_complex", "ebur128", "-f", "null", "-"]),
    run([
      "-hide_banner", "-i", inputPath, "-an",
      "-vf", analysisVideoFilter([
        "fps=4",
        "scale=160:-2",
        "select='gte(scene,0)'",
        "signalstats",
        "metadata=print:key=lavfi.scene_score",
        "metadata=print:key=lavfi.signalstats.YLOW",
        "metadata=print:key=lavfi.signalstats.YAVG",
        "metadata=print:key=lavfi.signalstats.YHIGH",
        "metadata=print:key=lavfi.signalstats.SATAVG",
      ], analysis.color),
      "-map", ffmpegVideoStreamSpecifier(analysis.videoStreamIndex),
      "-f", "null", "-",
    ]),
  ]);

  const loudSamples = parseEbur128(loudErr);
  const frameSamples = parseSceneScoreSamples(sceneErr);
  const compactMotion = compactMotionSamples(frameSamples);
  const visualSamples = compactVisualSignalSamples(parseVisualSignalSamples(sceneErr));
  return {
    loudPeaks: loudnessPeaks(loudSamples).slice(0, MAX_RANGES),
    cutDense: cutDensity(frameSamples.filter((sample) => sample.score > 0.3).map((sample) => sample.t)).slice(0, MAX_RANGES),
    motionPeaks: motionPeakRanges(frameSamples, frameSamples.at(-1)?.t ?? 0),
    motionSamples: compactMotion,
    activityKeyframes: activityKeyframes(frameSamples),
    visualSamples,
    loudnessSamples: loudSamples,
  };
}

/**
 * 把 ebur128 采样压成时间轴曲线:每格取窗内最大响度,再按全场 5%~99% 分位
 * 归一到 0..1(用分位不用 min/max——一声爆响不该把整条曲线压扁)。纯函数。
 */
export function loudnessCurve(
  samples: Array<{ t: number; m: number }>,
  durationSec: number,
  bins: number
): number[] {
  if (!(durationSec > 0) || bins < 1) return [];
  const out = new Float64Array(bins).fill(Number.NEGATIVE_INFINITY);
  for (const s of samples) {
    const i = Math.min(bins - 1, Math.max(0, Math.floor((s.t / durationSec) * bins)));
    if (s.m > out[i]) out[i] = s.m;
  }
  const present = [...out].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (present.length < 4) return new Array(bins).fill(0);
  const lo = present[Math.floor(present.length * 0.05)];
  const hi = present[Math.min(present.length - 1, Math.floor(present.length * 0.99))];
  const span = Math.max(1, hi - lo);
  return [...out].map((v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, (v - lo) / span)) : 0));
}

/** Compact motion samples → 0..1 timeline curve using robust upper-percentile scaling. */
export function motionCurve(samples: MotionSample[], durationSec: number, bins: number): number[] {
  if (!(durationSec > 0) || bins < 1) return [];
  const out = new Float64Array(bins);
  for (const sample of samples) {
    const index = Math.min(bins - 1, Math.max(0, Math.floor((sample.t / durationSec) * bins)));
    out[index] = Math.max(out[index], sample.score);
  }
  const present = [...out].filter((value) => value > 0).sort((a, b) => a - b);
  if (present.length < 4) return new Array(bins).fill(0);
  const lo = present[Math.floor(present.length * 0.25)];
  const hi = present[Math.min(present.length - 1, Math.floor(present.length * 0.98))];
  const span = Math.max(0.001, hi - lo);
  return [...out].map((value) => Math.min(1, Math.max(0, (value - lo) / span)));
}
