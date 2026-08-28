/**
 * 镜头边界检测(TransNetV2 ONNX)+ 切点吸附:让切片起止点落在真实的镜头
 * 切换上,成片不再从半个动作/半次转场开始。吸附只在不伤害语音的前提下
 * 进行(词边界守卫,向外优先);检测失败整体回退为不吸附——永远不会让
 * 输出更差。纯逻辑(解码/吸附)独立导出,可单测;ffmpeg 与 ONNX 执行隔离
 * 在 detectShotBoundaries 里。
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { resolveFfmpegPath } from "./binaries";
import { ensureModel, modelDir, TRANSNETV2_MODEL } from "./models";
import type { TranscriptWord } from "../shared/api-types";

const execFileAsync = promisify(execFile);

/** TransNetV2 训练域帧率——按此固定抽帧,帧号→秒的换算才稳定。 */
export const TRANSNET_FPS = 25;
/** 模型固定输入分辨率(宽×高)。 */
const FRAME_W = 48;
const FRAME_H = 27;
/** 100 帧滑窗:两侧各 25 帧只作上下文,中间 50 帧输出有效预测。 */
const WINDOW = 100;
const CONTEXT = 25;
const STRIDE = WINDOW - CONTEXT * 2;
const FRAME_BYTES = FRAME_W * FRAME_H * 3;
/** 单帧切换概率阈值(官方推荐 0.5;实测硬切 ≈0.98、平稳画面 ≈0.001)。 */
export const SHOT_THRESHOLD = 0.5;

/* eslint-disable @typescript-eslint/no-explicit-any */
let ort: any = null;
function loadOrt(): any {
  if (!ort) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ort = require("onnxruntime-node");
  }
  return ort;
}

// 31MB 模型进程内只加载一次;失败清空缓存,下次调用可重试
let sessionPromise: Promise<any> | null = null;
function getSession(modelsRoot: string): Promise<any> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      await ensureModel(modelsRoot, TRANSNETV2_MODEL);
      const path = join(modelDir(modelsRoot, TRANSNETV2_MODEL), TRANSNETV2_MODEL.singleFile!);
      return loadOrt().InferenceSession.create(path);
    })();
    sessionPromise.catch(() => {
      sessionPromise = null;
    });
  }
  return sessionPromise;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * 逐帧切换概率 → 边界时刻(秒,相对帧序列起点)。连续超阈值的一段取峰值
 * 帧;峰值帧是旧镜头的最后一帧,边界落在它与下一帧之间 = (peak+1)/fps。
 * 纯函数。
 */
export function decodeBoundaries(
  probs: ArrayLike<number>,
  fps = TRANSNET_FPS,
  threshold = SHOT_THRESHOLD
): number[] {
  const out: number[] = [];
  for (let i = 0; i < probs.length; i++) {
    if (probs[i] < threshold) continue;
    let peak = i;
    while (i < probs.length && probs[i] >= threshold) {
      if (probs[i] > probs[peak]) peak = i;
      i++;
    }
    out.push((peak + 1) / fps);
  }
  return out;
}

/** 吸附时允许的最大外扩(起点前移/终点后延)。 */
export const SNAP_MAX_OUT_SEC = 0.8;
/** 吸附时允许的最大内收——必须同时通过词边界守卫。 */
export const SNAP_MAX_IN_SEC = 0.35;
/** 切点与词之间保留的安全间隙。 */
const WORD_GUARD_SEC = 0.06;
/** 小于此值的位移不值得重切(本来就在边界上)。 */
const MIN_SNAP_DELTA_SEC = 0.05;
/** 吸附后不允许把片压得比这更短。 */
const MIN_CLIP_SEC = 1;

export interface SnapContext {
  /** 片内首词开始——内收起点不得越过它(缺省=不允许内收)。 */
  firstWordStartSec?: number;
  /** 片内末词结束——内收终点不得越过它(缺省=不允许内收)。 */
  lastWordEndSec?: number;
  /**
   * 片外紧邻的上一个词的结束时刻:外扩起点不得越过(null=片外确认无词,
   * 任意外扩;undefined=未知,放行——最多把 0.8s 无字幕的尾音收进来)。
   */
  prevWordEndSec?: number | null;
  /** 片外紧邻的下一个词的开始时刻,语义同上。 */
  nextWordStartSec?: number | null;
}

export interface SnapResult {
  startSec: number;
  endSec: number;
  /** 实际位移(秒,负=提前/正=延后);未吸附的一侧为 0。 */
  startDeltaSec: number;
  endDeltaSec: number;
  /** 至少一侧发生了有效吸附。 */
  snapped: boolean;
}

/** 在 [lo, hi] 里找离 target 最近且通过校验的边界;没有则 null。纯函数。 */
function nearestBoundary(
  boundaries: number[],
  target: number,
  lo: number,
  hi: number,
  allowed: (b: number) => boolean
): number | null {
  let best: number | null = null;
  for (const b of boundaries) {
    if (b < lo || b > hi || !allowed(b)) continue;
    if (best === null || Math.abs(b - target) < Math.abs(best - target)) best = b;
  }
  return best;
}

/**
 * 把切片起止点吸附到最近的镜头边界。规则:
 *  - 外扩(起点提前/终点延后)≤ SNAP_MAX_OUT_SEC,且不得越过片外紧邻的词;
 *  - 内收 ≤ SNAP_MAX_IN_SEC,且必须已知片内首/末词并留出安全间隙——
 *    绝不切掉说话;
 *  - 吸附后时长 < MIN_CLIP_SEC 时放弃该侧吸附。
 * 纯函数。
 */
export function snapClipToShots(
  startSec: number,
  endSec: number,
  boundaries: number[],
  ctx: SnapContext = {}
): SnapResult {
  const noSnap: SnapResult = { startSec, endSec, startDeltaSec: 0, endDeltaSec: 0, snapped: false };
  if (boundaries.length === 0 || !(endSec > startSec)) return noSnap;

  const startAllowed = (b: number): boolean => {
    if (b <= startSec) {
      // 外扩:不吞掉上一句的词
      return ctx.prevWordEndSec == null || b >= ctx.prevWordEndSec + WORD_GUARD_SEC;
    }
    // 内收:必须已知首词位置且不切到它
    return ctx.firstWordStartSec !== undefined && b <= ctx.firstWordStartSec - WORD_GUARD_SEC;
  };
  const endAllowed = (b: number): boolean => {
    if (b >= endSec) {
      return ctx.nextWordStartSec == null || b <= ctx.nextWordStartSec - WORD_GUARD_SEC;
    }
    return ctx.lastWordEndSec !== undefined && b >= ctx.lastWordEndSec + WORD_GUARD_SEC;
  };

  let newStart = nearestBoundary(
    boundaries, startSec, startSec - SNAP_MAX_OUT_SEC, startSec + SNAP_MAX_IN_SEC, startAllowed
  );
  let newEnd = nearestBoundary(
    boundaries, endSec, endSec - SNAP_MAX_IN_SEC, endSec + SNAP_MAX_OUT_SEC, endAllowed
  );
  if (newStart !== null && Math.abs(newStart - startSec) < MIN_SNAP_DELTA_SEC) newStart = null;
  if (newEnd !== null && Math.abs(newEnd - endSec) < MIN_SNAP_DELTA_SEC) newEnd = null;

  // 时长守卫:先放弃终点吸附,仍不够再放弃起点吸附
  const dur = () => (newEnd ?? endSec) - (newStart ?? startSec);
  if (dur() < MIN_CLIP_SEC) newEnd = null;
  if (dur() < MIN_CLIP_SEC) newStart = null;

  if (newStart === null && newEnd === null) return noSnap;
  return {
    startSec: newStart ?? startSec,
    endSec: newEnd ?? endSec,
    startDeltaSec: newStart === null ? 0 : newStart - startSec,
    endDeltaSec: newEnd === null ? 0 : newEnd - endSec,
    snapped: true,
  };
}

/**
 * 从全量词序列(按时间排序)里取片外紧邻词的时刻,供外扩守卫用。
 * 找不到相邻词时给 null(=确认片外无词,可放心外扩)。纯函数。
 */
export function snapContextAround(
  words: Array<Pick<TranscriptWord, "startSec" | "endSec">>,
  startSec: number,
  endSec: number
): { prevWordEndSec: number | null; nextWordStartSec: number | null } {
  let prev: number | null = null;
  let next: number | null = null;
  for (const w of words) {
    if (w.endSec <= startSec) {
      if (prev === null || w.endSec > prev) prev = w.endSec;
    } else if (w.startSec >= endSec) {
      if (next === null || w.startSec < next) next = w.startSec;
      break; // 词已排序,后面只会更远
    }
  }
  return { prevWordEndSec: prev, nextWordStartSec: next };
}

/**
 * 检测 [startSec, endSec] 窗口内的镜头边界,返回绝对时刻(秒)。
 * 抽帧走 ffmpeg rawvideo 管道(25fps 48×27 RGB),推理按 100 帧滑窗、
 * 步长 50,只采纳每窗中间 50 帧的预测;首尾窗口用首/尾帧填充补齐上下文。
 */
export async function detectShotBoundaries(
  inputPath: string,
  startSec: number,
  endSec: number,
  modelsRoot: string,
  signal?: AbortSignal
): Promise<number[]> {
  signal?.throwIfAborted();
  const base = Math.max(0, startSec);
  const dur = endSec - base;
  if (!(dur > 0)) return [];

  const { stdout } = await execFileAsync(
    resolveFfmpegPath(),
    [
      "-hide_banner", "-v", "error",
      "-ss", String(base), "-i", inputPath, "-t", String(dur),
      "-vf", `fps=${TRANSNET_FPS},scale=${FRAME_W}:${FRAME_H}`,
      "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ],
    // 512MB ≈ 2.3 小时帧数据上限——单片窗口远在其下,只是兜底
    { encoding: "buffer", maxBuffer: 512 * 1024 * 1024, signal }
  );
  const n = Math.floor(stdout.length / FRAME_BYTES);
  if (n < 2) return [];

  const session = await getSession(modelsRoot);
  const ortMod = loadOrt();
  const clamp = (i: number) => Math.min(n - 1, Math.max(0, i));
  const probs = new Float32Array(n);
  for (let winStart = 0; winStart < n; winStart += STRIDE) {
    signal?.throwIfAborted();
    const buf = new Float32Array(WINDOW * FRAME_BYTES);
    for (let k = 0; k < WINDOW; k++) {
      const src = clamp(winStart - CONTEXT + k) * FRAME_BYTES;
      for (let b = 0; b < FRAME_BYTES; b++) buf[k * FRAME_BYTES + b] = stdout[src + b];
    }
    const out = await session.run({
      input: new ortMod.Tensor("float32", buf, [1, WINDOW, FRAME_H, FRAME_W, 3]),
    });
    signal?.throwIfAborted();
    const p = out["534"].data as Float32Array;
    for (let k = CONTEXT; k < CONTEXT + STRIDE; k++) {
      const idx = winStart - CONTEXT + k;
      if (idx >= 0 && idx < n) probs[idx] = p[k];
    }
  }
  return decodeBoundaries(probs).map((t) => t + base);
}
