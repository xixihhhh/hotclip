/**
 * qa 修复循环(借鉴 video-use 的「渲染后自检→自动修复→重检」闭环,一轮):
 * 把质检告警里「机器自己就能修好」的问题当场修掉——
 *  - 首/尾长静音、首/尾黑屏 → 在成片上裁头/裁尾(不必重跑整条渲染管线,
 *    字幕已烧进画面,裁边不会错位);
 *  - 响度偏离 -14 目标 / 真峰值超限 → 视频流复制,只对音频再跑一遍 loudnorm。
 * 修完重跑一遍质检:报告变好才采纳,否则保留原片——机器不能把片修得更糟。
 * 切点半词类告警保持仅提示(上游跳剪/吸附本就带词边界守卫,重剪整条收益
 * 低风险高);片中黑屏/静音同理,那是内容问题,机器不该替人删内容。
 *
 * planRepair/buildRepairArgs 是纯函数(可单测);applyRepair 才碰 ffmpeg 与
 * 文件系统。失败语义与质检一致:fail-open,绝不拖垮导出。
 */
import { rename, rm } from "fs/promises";
import { toFfmpegTime } from "./time";
import { runFfmpeg, edgeFadeFilters, LOUDNORM_FILTER, LOUDNORM_OUT_RATE } from "./cut";
import { colorOutputArgs, type ColorRenderPlan } from "./color";
import { ffmpegAudioStreamSpecifier, ffmpegVideoStreamSpecifier } from "./probe";
import type { ClipQaReport, QaRepairRecord } from "./qa";

/** 静音/黑屏区间「贴着」片头/片尾的判定余量(秒)。 */
const EDGE_TOUCH_SEC = 0.25;
/** 裁静音时给语音留的呼吸垫(秒)——贴脸裁会显得急促。 */
const KEEP_PAD_SEC = 0.25;
/** 裁量下限(秒):比这还短的裁剪不值得再编码一遍。 */
const MIN_TRIM_SEC = 0.4;
/** 修复后成片时长下限(秒)与保留比例下限:裁过头宁可不裁。 */
const MIN_CLIP_SEC = 3;
const MIN_KEEP_FRAC = 0.5;
/** 响度偏差与真峰值阈值(与 qa.ts 的判定一致)。 */
const LOUDNESS_TOLERANCE_LU = 2;
const TRUE_PEAK_CEILING_DB = -1;

export interface RepairContext {
  /** 出片时开了响度标准化(响度修复只在此时有意义)。 */
  normalizeLoudness: boolean;
  /** 头部可裁(高潮前置把钩子迷你片拼在开头时不能动头)。 */
  headTrimmable: boolean;
}

/** 一轮修复计划(输出时间轴)。 */
export interface RepairPlan {
  /** 音频再跑一遍 loudnorm(响度偏离/真峰值超限)。 */
  loudness: boolean;
  /** 新起点(>0 = 裁头)。 */
  trimStartSec: number;
  /** 新终点(非 null = 裁尾)。 */
  trimEndSec: number | null;
  /** 共裁掉多少秒(重检时校正预期时长用)。 */
  trimmedSec: number;
  /** 人类可读动作清单(进 clips.json 的 qa.repair.actions)。 */
  actions: string[];
}

const fmtSec = (v: number): string => v.toFixed(1);

/**
 * 从质检报告推导修复计划;没有可自愈项返回 null。
 * 只认贴着首尾的静音/黑屏——片中区间是内容取舍,不归机器管。
 */
export function planRepair(report: ClipQaReport, ctx: RepairContext): RepairPlan | null {
  const dur = report.durationSec;
  const actions: string[] = [];

  // 裁头:贴片头的静音(留呼吸垫)与黑屏(整段裁掉)取最大裁点
  let trimStart = 0;
  if (ctx.headTrimmable) {
    for (const s of report.silenceSpans) {
      if (s.startSec <= EDGE_TOUCH_SEC) trimStart = Math.max(trimStart, s.endSec - KEEP_PAD_SEC);
    }
    for (const b of report.blackSpans) {
      if (b.startSec <= EDGE_TOUCH_SEC) trimStart = Math.max(trimStart, b.endSec);
    }
    trimStart = Math.max(0, trimStart);
    if (trimStart < MIN_TRIM_SEC) trimStart = 0;
  }

  // 裁尾:贴片尾的静音/黑屏取最小新终点
  let trimEnd: number | null = null;
  for (const s of report.silenceSpans) {
    if (s.endSec >= dur - EDGE_TOUCH_SEC) {
      const at = s.startSec + KEEP_PAD_SEC;
      trimEnd = trimEnd === null ? at : Math.min(trimEnd, at);
    }
  }
  for (const b of report.blackSpans) {
    if (b.endSec >= dur - EDGE_TOUCH_SEC) {
      trimEnd = trimEnd === null ? b.startSec : Math.min(trimEnd, b.startSec);
    }
  }
  if (trimEnd !== null && (dur - trimEnd < MIN_TRIM_SEC || trimEnd <= 0)) trimEnd = null;

  // 裁过头守卫:修复后太短/裁掉太多 → 放弃裁剪(静音告警留给人判断)
  const newDur = (trimEnd ?? dur) - trimStart;
  if (newDur < MIN_CLIP_SEC || newDur < dur * MIN_KEEP_FRAC) {
    trimStart = 0;
    trimEnd = null;
  }

  if (trimStart > 0) actions.push(`裁掉开头 ${fmtSec(trimStart)}s 静音/黑屏`);
  if (trimEnd !== null) actions.push(`裁掉结尾 ${fmtSec(dur - trimEnd)}s 静音/黑屏`);

  // 响度:只在出片开了标准化、且实测确实偏了/超峰时重归一
  const loudness =
    ctx.normalizeLoudness &&
    report.loudness !== null &&
    (Math.abs(report.loudness.integratedLufs - -14) > LOUDNESS_TOLERANCE_LU ||
      report.loudness.truePeakDb > TRUE_PEAK_CEILING_DB);
  if (loudness) actions.push("音频响度二遍归一(-14 LUFS)");

  if (actions.length === 0) return null;
  const trimmedSec = trimStart + (trimEnd !== null ? dur - trimEnd : 0);
  return { loudness, trimStartSec: trimStart, trimEndSec: trimEnd, trimmedSec: Number(trimmedSec.toFixed(3)), actions };
}

/**
 * 修复的 ffmpeg 参数(纯函数)。裁剪需要重编码(帧精确);只修响度时
 * 视频流复制,秒级完成零画质损失。
 */
export function buildRepairArgs(
  inPath: string,
  outPath: string,
  plan: RepairPlan,
  durationSec: number,
  color?: ColorRenderPlan,
  videoStreamIndex?: number,
  audioStreamIndex?: number
): string[] {
  const trims = plan.trimStartSec > 0 || plan.trimEndSec !== null;
  const maps = [
    "-map", ffmpegVideoStreamSpecifier(videoStreamIndex),
    "-map", ffmpegAudioStreamSpecifier(audioStreamIndex, 0, true),
  ];
  if (!trims) {
    // 仅响度:-c:v copy,只重编音频
    return [
      "-hide_banner", "-y",
      "-i", inPath,
      ...maps,
      "-c:v", "copy",
      "-af", LOUDNORM_FILTER,
      "-ar", LOUDNORM_OUT_RATE,
      "-c:a", "aac",
      "-b:a", "192k",
      ...colorOutputArgs(color),
      "-movflags", "+faststart",
      outPath,
    ];
  }
  const start = Math.max(0, plan.trimStartSec);
  const newDur = Math.max(0.1, (plan.trimEndSec ?? durationSec) - start);
  // 音频链与出片同规:loudnorm 在前,新边界的 30ms 淡化收尾防爆音
  const audioChain = [...(plan.loudness ? [LOUDNORM_FILTER] : []), ...edgeFadeFilters(newDur)];
  return [
    "-hide_banner", "-y",
    "-ss", toFfmpegTime(start),
    "-i", inPath,
    "-t", toFfmpegTime(newDur),
    ...maps,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    ...colorOutputArgs(color),
    ...(audioChain.length > 0 ? ["-af", audioChain.join(",")] : []),
    ...(plan.loudness ? ["-ar", LOUDNORM_OUT_RATE] : []),
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    outPath,
  ];
}

export interface RepairOutcome {
  /** 最终质检报告(带 repair 记录;未采纳时是原报告 + 记录)。 */
  report: ClipQaReport;
  /** true = 成片已被修复版替换。 */
  applied: boolean;
}

/**
 * 执行一轮修复:渲染修复版 → 重跑质检 → 告警严格变少才替换原片,
 * 否则删修复版保留原片(机器不能把片修得更糟)。reQa 由调用方注入
 * (带正确的预期时长与切点上下文)。抛错由调用方兜底(fail-open)。
 */
export async function applyRepair(
  path: string,
  plan: RepairPlan,
  before: ClipQaReport,
  reQa: (fixedPath: string) => Promise<ClipQaReport>,
  signal?: AbortSignal,
  color?: ColorRenderPlan,
  videoStreamIndex?: number,
  audioStreamIndex?: number
): Promise<RepairOutcome> {
  const fixPath = path.replace(/\.mp4$/, ".fix.mp4");
  const record = (applied: boolean): QaRepairRecord => ({
    actions: plan.actions,
    beforeIssues: before.issues,
    applied,
  });
  try {
    await runFfmpeg(
      buildRepairArgs(path, fixPath, plan, before.durationSec, color, videoStreamIndex, audioStreamIndex),
      { signal }
    );
    const fixed = await reQa(fixPath);
    if (fixed.issues.length < before.issues.length) {
      await rename(fixPath, path);
      return { report: { ...fixed, repair: record(true) }, applied: true };
    }
    await rm(fixPath, { force: true });
    return { report: { ...before, repair: record(false) }, applied: false };
  } catch (e) {
    await rm(fixPath, { force: true }).catch(() => {});
    throw e;
  }
}
