/**
 * 表情峰值信号:YuNet 找主脸 + FER+ 表情识别(两个几 MB 的 MIT ONNX 模型,
 * 零配置开箱即用),在采样帧上找"大笑/惊讶/激动"的表情峰值时刻,并成时段
 * 作为视听信号进爆点判断——视觉爆点信号的免费版:不装 Ollama 也能让 AI
 * "看见"情绪爆点。
 *
 * 采样策略:响度峰值/镜头密集段窗口内 2s 步进(那里最可能有表情),剩余
 * 额度均匀铺满全片。全程 fail-open:模型下载失败/无人脸/预算耗尽都只是
 * 没有该信号,绝不拖垮检测。纯函数(采样规划/灰度裁脸/softmax/峰值分)
 * 可单测;ffmpeg 与 ONNX 推理通过注入点替换。
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { resolveFfmpegPath } from "./binaries";
import { modelDir, ensureModel, EMOTION_MODEL } from "./models";
import type { MediaSignals, TimeRange } from "./signals";
import { YunetDetector, pickMainFace, YUNET_INPUT, type FaceBox } from "./reframe/yunet";
import { visualPeakRanges } from "./highlight/vision";

const execFileAsync = promisify(execFile);

/** 全片采样帧上限(CPU 推理每帧几十 ms,96 帧把最坏耗时压在分钟内)。 */
export const EMOTION_MAX_FRAMES = 96;
/** 信号窗口内的采样步长(表情峰值持续时间短,窗口内要比全片密)。 */
export const EMOTION_WINDOW_STEP_SEC = 2;
/** 两帧最小间隔。 */
export const EMOTION_MIN_SPACING_SEC = 3;
/** 表情峰值概率阈值(笑/惊/怒三类的最大 softmax 概率)。 */
export const EMOTION_PEAK_PROB = 0.6;
/** FER+ 输入尺寸。 */
export const FER_INPUT = 64;
/** 总预算:超时带着已得结果收工。 */
const EMOTION_BUDGET_MS = 90_000;
/** 检出人脸的帧少于该数时证据太薄,不给信号。 */
const MIN_FACE_FRAMES = 3;

/** FER+ 输出类别顺序(官方):0=中性 1=开心 2=惊讶 3=悲伤 4=愤怒 5=厌恶 6=恐惧 7=轻蔑 */
const IDX_HAPPY = 1;
const IDX_SURPRISE = 2;
const IDX_ANGER = 4;

export interface EmotionStats {
  framesTotal: number;
  /** 检出人脸并完成表情打分的帧数。 */
  facesScored: number;
  peakCount: number;
}

export interface EmotionOutcome {
  emotionPeaks: TimeRange[];
  stats: EmotionStats;
}

/**
 * 规划采样时刻:信号窗口内 2s 步进优先,均匀网格补满,保持最小间隔。纯函数。
 */
export function planEmotionFrameTimes(
  durationSec: number,
  signals: MediaSignals | undefined,
  maxFrames = EMOTION_MAX_FRAMES,
  minSpacingSec = EMOTION_MIN_SPACING_SEC,
  windowStepSec = EMOTION_WINDOW_STEP_SEC
): number[] {
  if (!(durationSec > 1) || maxFrames < 1) return [];
  const lo = 0.5;
  const hi = durationSec - 0.5;
  const clamp = (t: number): number => Math.min(hi, Math.max(lo, t));
  const picked: number[] = [];
  const fits = (t: number): boolean => picked.every((p) => Math.abs(p - t) >= minSpacingSec);
  const tryPick = (t: number): void => {
    const c = clamp(t);
    if (picked.length < maxFrames && fits(c)) picked.push(c);
  };
  // 信号窗口内步进采样(表情峰值就藏在响度峰值/镜头密集段里)
  const windows = [...(signals?.loudPeaks ?? []), ...(signals?.cutDense ?? [])]
    .sort((a, b) => a.startSec - b.startSec);
  for (const w of windows) {
    for (let t = w.startSec; t <= w.endSec; t += windowStepSec) tryPick(t);
  }
  // 均匀网格兜底,防信号盲区整段漏掉
  for (let i = 1; i <= maxFrames; i++) tryPick((durationSec * i) / (maxFrames + 1));
  return picked.sort((a, b) => a - b);
}

/**
 * 从 640×640 letterboxed BGR 帧裁出人脸框,灰度化并双线性缩放到 64×64。
 * 输出 0-255 原始灰度(FER+ 官方预处理不归一化)。纯函数。
 */
export function grayFaceTensor(bgr: Uint8Array, inputSize: number, box: FaceBox): Float32Array {
  const out = new Float32Array(FER_INPUT * FER_INPUT);
  // 脸框各向外扩 15%(FER+ 训练数据带头部余量),再夹回帧内
  const pad = 0.15;
  const bx = Math.max(0, box.x - box.w * pad);
  const by = Math.max(0, box.y - box.h * pad);
  const bw = Math.min(inputSize - bx, box.w * (1 + 2 * pad));
  const bh = Math.min(inputSize - by, box.h * (1 + 2 * pad));
  for (let oy = 0; oy < FER_INPUT; oy++) {
    for (let ox = 0; ox < FER_INPUT; ox++) {
      // 双线性采样源坐标
      const sx = bx + ((ox + 0.5) / FER_INPUT) * bw - 0.5;
      const sy = by + ((oy + 0.5) / FER_INPUT) * bh - 0.5;
      const x0 = Math.max(0, Math.min(inputSize - 1, Math.floor(sx)));
      const y0 = Math.max(0, Math.min(inputSize - 1, Math.floor(sy)));
      const x1 = Math.min(inputSize - 1, x0 + 1);
      const y1 = Math.min(inputSize - 1, y0 + 1);
      const fx = Math.max(0, Math.min(1, sx - x0));
      const fy = Math.max(0, Math.min(1, sy - y0));
      const gray = (px: number, py: number): number => {
        const i = (py * inputSize + px) * 3;
        // BGR → 灰度(BT.601)
        return 0.114 * bgr[i] + 0.587 * bgr[i + 1] + 0.299 * bgr[i + 2];
      };
      const top = gray(x0, y0) * (1 - fx) + gray(x1, y0) * fx;
      const bot = gray(x0, y1) * (1 - fx) + gray(x1, y1) * fx;
      out[oy * FER_INPUT + ox] = top * (1 - fy) + bot * fy;
    }
  }
  return out;
}

/** 数值稳定 softmax。纯函数。 */
export function softmax(logits: ArrayLike<number>): number[] {
  let max = -Infinity;
  for (let i = 0; i < logits.length; i++) if (logits[i] > max) max = logits[i];
  const exps: number[] = [];
  let sum = 0;
  for (let i = 0; i < logits.length; i++) {
    const e = Math.exp(logits[i] - max);
    exps.push(e);
    sum += e;
  }
  return exps.map((e) => e / sum);
}

/** 表情峰值分:笑/惊/怒三类概率的最大值(切片爆点三情绪)。纯函数。 */
export function emotionPeakScore(probs: number[]): number {
  return Math.max(probs[IDX_HAPPY] ?? 0, probs[IDX_SURPRISE] ?? 0, probs[IDX_ANGER] ?? 0);
}

/** FER+ 推理会话(与 YunetDetector 同款懒加载 onnxruntime-node)。 */
export class EmotionScorer {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  private session: any = null;

  constructor(private modelsRoot: string) {}

  async init(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const o = require("onnxruntime-node");
    const path = join(modelDir(this.modelsRoot, EMOTION_MODEL), EMOTION_MODEL.singleFile ?? "model.onnx");
    this.session = await o.InferenceSession.create(path);
  }

  /** gray64: 64×64 灰度(0-255)。返回 8 类 softmax 概率。 */
  async score(gray64: Float32Array): Promise<number[]> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const o = require("onnxruntime-node");
    const tensor = new o.Tensor("float32", gray64, [1, 1, FER_INPUT, FER_INPUT]);
    const outputs = await this.session.run({ [this.session.inputNames[0]]: tensor });
    const logits = (outputs[this.session.outputNames[0]] as { data: Float32Array }).data;
    return softmax(logits);
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** 抽一帧 640×640 letterboxed BGR(与人脸追踪同款滤镜,保持宽高比)。 */
export async function extractLetterboxedFrame(videoPath: string, tSec: number): Promise<Uint8Array | null> {
  try {
    const n = YUNET_INPUT;
    const { stdout } = await execFileAsync(
      resolveFfmpegPath(),
      [
        "-hide_banner", "-v", "error",
        "-ss", tSec.toFixed(2), "-i", videoPath, "-frames:v", "1",
        "-vf", `scale=${n}:${n}:force_original_aspect_ratio=decrease,pad=${n}:${n}:(ow-iw)/2:(oh-ih)/2:black`,
        "-f", "rawvideo", "-pix_fmt", "bgr24", "-",
      ],
      { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 }
    );
    return stdout.length === n * n * 3 ? new Uint8Array(stdout) : null;
  } catch {
    return null;
  }
}

export interface EmotionDeps {
  extractFrame: (videoPath: string, tSec: number) => Promise<Uint8Array | null>;
  detectFaces: (bgr: Uint8Array) => Promise<FaceBox[]>;
  scoreEmotion: (gray64: Float32Array) => Promise<number[]>;
}

/** 默认依赖:确保模型就位并初始化两个推理会话(下载失败上抛→外层 fail-open)。 */
async function defaultDeps(modelsRoot: string): Promise<EmotionDeps> {
  const { YUNET_MODEL } = await import("./models");
  await ensureModel(modelsRoot, YUNET_MODEL);
  await ensureModel(modelsRoot, EMOTION_MODEL);
  const detector = new YunetDetector(modelsRoot);
  await detector.init();
  const scorer = new EmotionScorer(modelsRoot);
  await scorer.init();
  return {
    extractFrame: extractLetterboxedFrame,
    detectFaces: (bgr) => detector.detect(bgr),
    scoreEmotion: (g) => scorer.score(g),
  };
}

/**
 * 采集表情峰值信号。fail-open:
 * - 模型下载/初始化失败 → null;
 * - 单帧抽帧/检测失败 → 跳过该帧;
 * - 检出人脸的帧不足 MIN_FACE_FRAMES → null(没人脸的素材天然没有该信号);
 * - 超总预算 → 带着已得结果收工。
 */
export async function collectEmotionSignal(opts: {
  videoPath: string;
  durationSec: number;
  modelsRoot: string;
  signals?: MediaSignals;
  deps?: EmotionDeps;
  budgetMs?: number;
}): Promise<EmotionOutcome | null> {
  const { videoPath, durationSec, modelsRoot, signals, budgetMs = EMOTION_BUDGET_MS } = opts;
  const times = planEmotionFrameTimes(durationSec, signals);
  if (times.length === 0) return null;
  let deps: EmotionDeps;
  try {
    deps = opts.deps ?? (await defaultDeps(modelsRoot));
  } catch {
    return null; // 模型不可用:静默没有该信号
  }
  const deadline = Date.now() + budgetMs;
  const scored: Array<{ t: number; energy: number }> = [];
  let prevMain: FaceBox | null = null;
  let facesScored = 0;
  for (const t of times) {
    if (Date.now() > deadline) break; // 预算耗尽,带着已得结果收工
    const bgr = await deps.extractFrame(videoPath, t);
    if (!bgr) continue;
    try {
      const faces = await deps.detectFaces(bgr);
      const main = pickMainFace(faces, prevMain);
      prevMain = main;
      if (!main) continue;
      const probs = await deps.scoreEmotion(grayFaceTensor(bgr, YUNET_INPUT, main));
      facesScored++;
      // 概率 → 0-10 能量,复用视觉信号的圈段逻辑
      scored.push({ t, energy: emotionPeakScore(probs) * 10 });
    } catch {
      // 单帧失败跳过
    }
  }
  if (facesScored < MIN_FACE_FRAMES) return null;
  const emotionPeaks = visualPeakRanges(scored, durationSec, EMOTION_PEAK_PROB * 10);
  return {
    emotionPeaks,
    stats: { framesTotal: times.length, facesScored, peakCount: emotionPeaks.length },
  };
}
