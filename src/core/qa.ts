/**
 * 出片自我质检(render QA):成片渲染完成后用一遍 ffmpeg 解码扫描 +
 * 一次切点核对,把「AI 切得好不好」变成机器可核对的报告——黑屏、长静音、
 * 响度/时长偏差、切点压在词中间(半词风险),全部写进 clips.json 的 qa
 * 字段并回传给 MCP/CLI。用户只需要看告警条,不用逐条回放验证。
 *
 * 解析器与判定全部是纯函数(stderr 文本 → 结构化区间 → 报告),可单测;
 * 只有 runClipQa 真正跑 ffmpeg/ffprobe。检测自身失败由调用方兜底置空,
 * 绝不拖垮导出(与封面/SRT 等附属产物同一语义)。
 */
import { spawn } from "child_process";
import { resolveFfmpegPath } from "./binaries";
import { probeMedia } from "./probe";
import { EDGE_FADE_SEC } from "./cut";
import { formatLintIssue, type LintHit } from "./content-lint";
import type { TranscriptWord } from "../shared/api-types";

/** 一段被检出的可疑区间(成片输出时间轴,秒)。 */
export interface QaSpan {
  startSec: number;
  endSec: number;
}

/** 单条成片的质检报告(进 clips.json 的 qa 字段)。 */
export interface ClipQaReport {
  /** pass = 全部检查通过;warn = 有告警条目(见 issues)。 */
  status: "pass" | "warn";
  /** 人类可读的告警清单(空数组即通过)。 */
  issues: string[];
  /** 成片实测时长与管线预期时长(秒)。 */
  durationSec: number;
  expectedDurationSec: number;
  /** 黑屏区间(≥0.5s 且画面近全黑)。 */
  blackSpans: QaSpan[];
  /** 长静音区间(≥2s;开了跳剪还剩长静音尤其可疑)。 */
  silenceSpans: QaSpan[];
  /** 响度实测(EBU R128);音频扫描失败为 null。 */
  loudness: { integratedLufs: number; truePeakDb: number } | null;
  /** 落在词中间的切点数(0 = 每个切点都在词边界外,无半词风险)。 */
  midWordCuts: number | null;
  /** 平台违禁词命中(标题/钩子/文案/字幕);没跑 lint 为 null。 */
  contentHits: LintHit[] | null;
  /** 最长「无视觉变化」间隔(秒);没做节奏评估(有字幕/运镜兜底)为 null。 */
  pacingGapSec: number | null;
  /** 自动修复记录(qa 修复循环执行过才有);见 repair.ts。 */
  repair?: QaRepairRecord;
}

/** qa 修复循环的执行记录(进 clips.json,「AI 又改了什么」要可审计)。 */
export interface QaRepairRecord {
  /** 修复动作的人类可读描述(裁头/裁尾/响度重归一)。 */
  actions: string[];
  /** 修复前的告警清单(与修复后的 issues 对照)。 */
  beforeIssues: string[];
  /** true = 修复后的成片被采纳;false = 修复没让报告变好,保留原片。 */
  applied: boolean;
}

/** 黑屏判定:0.5s 起报(短于此多为正常转场/闪黑)。 */
const BLACK_MIN_SEC = 0.5;
/** 静音判定:-50dB 以下持续 2s 起报。 */
const SILENCE_MIN_SEC = 2;
/** 响度容差:偏离 -14 LUFS 目标超过 ±2 LU 才告警(loudnorm 单遍本有浮动)。 */
const LOUDNESS_TOLERANCE_LU = 2;
/** 真峰值上限:超过 -1 dBTP 有平台转码削波风险。 */
const TRUE_PEAK_CEILING_DB = -1;
/** 时长偏差容忍(秒):超过多为拼接/剪切错位。 */
const DURATION_TOLERANCE_SEC = 0.75;
/** 切点离词边界的容差:淡化时长再放宽一点,压线不算切进词里。 */
const BOUNDARY_TOLERANCE_SEC = EDGE_FADE_SEC + 0.02;
/**
 * 画面节奏告警线(秒):2026 调研口径「有意义的视觉变化间隔 ≤3s,硬顶 5s」
 * (RESEARCH-2026-08-CLIP-QUALITY.md 第三节)。这里取硬顶——只在明显偏慢时
 * 提醒,不对风格化的慢节奏指手画脚。
 */
export const PACING_MAX_GAP_SEC = 5;

/**
 * 视觉事件序列(拼接缝/跳剪缝/高潮前置接缝等,输出时间轴)→ 最长无变化
 * 间隔。片头片尾各算一个天然事件。纯函数;调用方在有字幕/自动运镜兜底时
 * 不必调用(连续的视觉变化已覆盖节奏)。
 */
export function maxVisualGapSec(eventsSec: number[], durationSec: number): number {
  const pts = [...new Set([0, ...eventsSec.filter((t) => t > 0 && t < durationSec), durationSec])].sort(
    (a, b) => a - b
  );
  let maxGap = 0;
  for (let i = 1; i < pts.length; i++) maxGap = Math.max(maxGap, pts[i] - pts[i - 1]);
  return Number(maxGap.toFixed(2));
}

/** blackdetect 输出解析:`black_start:1.2 black_end:2.0 ...`(同行成对)。 */
export function parseBlackSpans(stderr: string): QaSpan[] {
  const spans: QaSpan[] = [];
  const re = /black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)/g;
  for (let m = re.exec(stderr); m; m = re.exec(stderr)) {
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      spans.push({ startSec: start, endSec: end });
    }
  }
  return spans;
}

/**
 * silencedetect 输出解析:start/end 分行出现,按序配对。收尾只有 start
 * 没 end(静音贯穿到片尾)时,用 streamEndSec 闭合;不传则丢弃不完整对。
 */
export function parseSilenceSpans(stderr: string, streamEndSec?: number): QaSpan[] {
  const spans: QaSpan[] = [];
  let open: number | null = null;
  const re = /silence_(start|end):\s*(-?[\d.]+)/g;
  for (let m = re.exec(stderr); m; m = re.exec(stderr)) {
    const v = Number(m[2]);
    if (!Number.isFinite(v)) continue;
    if (m[1] === "start") {
      open = v;
    } else if (open !== null) {
      if (v > open) spans.push({ startSec: Math.max(0, open), endSec: v });
      open = null;
    }
  }
  if (open !== null && streamEndSec !== undefined && streamEndSec > open) {
    spans.push({ startSec: Math.max(0, open), endSec: streamEndSec });
  }
  return spans;
}

/**
 * ebur128 汇总解析:取末尾 Summary 的整片响度与真峰值。
 * 形如 `I: -14.1 LUFS` / `Peak: -1.3 dBFS`(peak=true 时为真峰值)。
 */
export function parseLoudnessSummary(stderr: string): ClipQaReport["loudness"] {
  const iMatches = [...stderr.matchAll(/I:\s*(-?[\d.]+)\s*LUFS/g)];
  const pMatches = [...stderr.matchAll(/Peak:\s*(-?[\d.]+)\s*dBFS/g)];
  if (iMatches.length === 0 || pMatches.length === 0) return null;
  const integratedLufs = Number(iMatches[iMatches.length - 1][1]);
  const truePeakDb = Number(pMatches[pMatches.length - 1][1]);
  if (!Number.isFinite(integratedLufs) || !Number.isFinite(truePeakDb)) return null;
  return { integratedLufs, truePeakDb };
}

/**
 * 切点核对(纯函数):每个保留段的起止点(源时间轴)是否压在某个词的
 * 中间——跳剪与镜头吸附都带词边界守卫,这里是「信任但要验证」的复核。
 * words 与 segments 都用源片绝对时间。
 */
export function countMidWordCuts(
  words: TranscriptWord[],
  segments: QaSpan[],
  toleranceSec = BOUNDARY_TOLERANCE_SEC
): number {
  if (words.length === 0 || segments.length === 0) return 0;
  const cuts = segments.flatMap((s) => [s.startSec, s.endSec]);
  let hits = 0;
  for (const t of cuts) {
    const inside = words.some((w) => w.startSec + toleranceSec < t && t < w.endSec - toleranceSec);
    if (inside) hits += 1;
  }
  return hits;
}

/** 判定输入(全部由调用方备好,便于单测)。 */
export interface QaAssessment {
  durationSec: number;
  expectedDurationSec: number;
  blackSpans: QaSpan[];
  silenceSpans: QaSpan[];
  loudness: ClipQaReport["loudness"];
  /** 出片时开了响度标准化才核对 -14 LUFS 目标。 */
  loudnessNormalized: boolean;
  midWordCuts: number | null;
  /** 平台违禁词命中(调用方用 content-lint 扫好传入);缺省 = 没扫。 */
  contentHits?: LintHit[] | null;
  /** 最长无视觉变化间隔(maxVisualGapSec 算好传入);缺省 = 不评估节奏。 */
  pacingGapSec?: number | null;
}

const fmtSec = (v: number): string => v.toFixed(1);

/** 纯判定:各项实测 → 告警清单与状态。 */
export function assessClipQa(input: QaAssessment): ClipQaReport {
  const issues: string[] = [];
  const delta = Math.abs(input.durationSec - input.expectedDurationSec);
  if (input.expectedDurationSec > 0 && delta > DURATION_TOLERANCE_SEC) {
    issues.push(`成片时长 ${fmtSec(input.durationSec)}s 与预期 ${fmtSec(input.expectedDurationSec)}s 偏差 ${fmtSec(delta)}s`);
  }
  if (input.blackSpans.length > 0) {
    const longest = Math.max(...input.blackSpans.map((s) => s.endSec - s.startSec));
    issues.push(`检测到黑屏 ${input.blackSpans.length} 段(最长 ${fmtSec(longest)}s)`);
  }
  if (input.silenceSpans.length > 0) {
    const longest = Math.max(...input.silenceSpans.map((s) => s.endSec - s.startSec));
    issues.push(`检测到长静音 ${input.silenceSpans.length} 段(最长 ${fmtSec(longest)}s)`);
  }
  if (input.loudnessNormalized && input.loudness) {
    const dev = Math.abs(input.loudness.integratedLufs - -14);
    if (dev > LOUDNESS_TOLERANCE_LU) {
      issues.push(`响度 ${input.loudness.integratedLufs.toFixed(1)} LUFS 偏离 -14 目标 ${dev.toFixed(1)} LU`);
    }
    if (input.loudness.truePeakDb > TRUE_PEAK_CEILING_DB) {
      issues.push(`真峰值 ${input.loudness.truePeakDb.toFixed(1)} dBTP 超过 ${TRUE_PEAK_CEILING_DB} 上限(平台转码有削波风险)`);
    }
  }
  if ((input.midWordCuts ?? 0) > 0) {
    issues.push(`${input.midWordCuts} 处切点落在词中间(可能出现半词,建议回放核对)`);
  }
  if ((input.pacingGapSec ?? 0) > PACING_MAX_GAP_SEC) {
    issues.push(
      `画面 ${fmtSec(input.pacingGapSec!)}s 无视觉变化(节奏偏慢,建议开启自动运镜或字幕)`
    );
  }
  const lintIssue = formatLintIssue(input.contentHits ?? []);
  if (lintIssue) issues.push(lintIssue);
  return {
    status: issues.length > 0 ? "warn" : "pass",
    issues,
    durationSec: Number(input.durationSec.toFixed(3)),
    expectedDurationSec: Number(input.expectedDurationSec.toFixed(3)),
    blackSpans: input.blackSpans.map((s) => ({ startSec: Number(s.startSec.toFixed(2)), endSec: Number(s.endSec.toFixed(2)) })),
    silenceSpans: input.silenceSpans.map((s) => ({ startSec: Number(s.startSec.toFixed(2)), endSec: Number(s.endSec.toFixed(2)) })),
    loudness: input.loudness
      ? { integratedLufs: Number(input.loudness.integratedLufs.toFixed(1)), truePeakDb: Number(input.loudness.truePeakDb.toFixed(1)) }
      : null,
    midWordCuts: input.midWordCuts,
    contentHits: input.contentHits ?? null,
    pacingGapSec: input.pacingGapSec ?? null,
  };
}

/** stderr 收集上限:detect 行 + ebur128 汇总远小于此,防素材异常刷爆内存。 */
const STDERR_CAP = 4 * 1024 * 1024;

/**
 * 解码扫描一遍成片,收集完整 stderr(blackdetect/silencedetect 行散布
 * 全程,ebur128 汇总在末尾——不能像 runFfmpeg 那样只留尾部)。
 */
export async function scanClipMedia(path: string, signal?: AbortSignal): Promise<string> {
  const args = [
    "-hide_banner", "-nostats",
    "-i", path,
    "-vf", `blackdetect=d=${BLACK_MIN_SEC}:pix_th=0.10`,
    "-af", `silencedetect=n=-50dB:d=${SILENCE_MIN_SEC},ebur128=peak=true`,
    "-f", "null", "-",
  ];
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(resolveFfmpegPath(), args, { stdio: ["ignore", "ignore", "pipe"], signal });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < STDERR_CAP) stderr += d.toString();
    });
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`qa scan exited ${code}`));
    });
  });
}

export interface RunClipQaOptions {
  /** 管线预期成片时长(切片时长 + 高潮前置迷你片)。 */
  expectedDurationSec: number;
  /** 出片是否开了响度标准化(决定是否核对 -14 LUFS)。 */
  loudnessNormalized: boolean;
  /** 切片覆盖的词(源片绝对时间);缺省跳过切点核对。 */
  words?: TranscriptWord[];
  /** 实际保留的源片段(跳剪后多段);与 words 同为源片绝对时间。 */
  segments?: QaSpan[];
  /** 平台违禁词命中(content-lint 扫标题/钩子/文案/字幕的结果)。 */
  contentHits?: LintHit[] | null;
  /** 最长无视觉变化间隔(调用方按剪辑计划算好);缺省 = 不评估节奏。 */
  pacingGapSec?: number | null;
  signal?: AbortSignal;
}

/** 对一条成片跑完整质检:解码扫描 + ffprobe 时长 + 切点核对 → 报告。 */
export async function runClipQa(path: string, opts: RunClipQaOptions): Promise<ClipQaReport> {
  const [stderr, info] = await Promise.all([scanClipMedia(path, opts.signal), probeMedia(path)]);
  return assessClipQa({
    durationSec: info.durationSec,
    expectedDurationSec: opts.expectedDurationSec,
    blackSpans: parseBlackSpans(stderr),
    silenceSpans: parseSilenceSpans(stderr, info.durationSec),
    loudness: parseLoudnessSummary(stderr),
    loudnessNormalized: opts.loudnessNormalized,
    midWordCuts: opts.words && opts.segments ? countMidWordCuts(opts.words, opts.segments) : null,
    contentHits: opts.contentHits,
    pacingGapSec: opts.pacingGapSec,
  });
}
