/**
 * 视觉爆点信号:端侧视觉模型(Ollama qwen3-vl 等)抽帧研判"画面高能时刻",
 * 并成时段后作为第三条视听信号进 LLM 提示词——解决纯文本检测"看不见画面"
 * 的行业通病(表情包式画面/肢体梗/场景炸点在转写文本里是空白)。
 *
 * 抽帧时刻优先取 Tier-0 信号(响度峰值/镜头密集段)圈出的窗口中点——它们是
 * "这里可能有画面"的免费先验;剩余额度均匀铺满全片防漏。研判按 3×3 接触表
 * 批量走:九帧拼一张带序号的九宫格,一次调用出九个分——调用次数比逐帧降
 * 一个量级(27 帧只要 3 次)。全程 fail-open:端点不可用/单表失败/预算耗尽
 * 都不能拖垮检测,最差退回纯文本结果。
 * 纯函数(规划/解析/并段)可单测;拼图与 HTTP 通过注入点替换。
 */
import type { LlmConfig } from "../../shared/api-types";
import { chunkCells, composeContactSheetJpeg } from "../contact-sheet";
import type { MediaSignals, TimeRange } from "../signals";
import { stripThinkBlocks } from "./prefilter";

/** 全片抽帧上限——接触表批量研判后一次调用看九帧,27 帧=3 次调用。 */
export const VISION_MAX_FRAMES = 27;
/** 两帧最小间隔:同一个画面高潮抽两帧是浪费额度。 */
export const VISION_MIN_SPACING_SEC = 8;
/** energy(0-10) 达到该值的帧才算"画面高能"。 */
export const VISION_ENERGY_THRESHOLD = 7;
/** 高能帧向两侧扩出的时段半径(画面高潮通常持续数秒)。 */
export const VISION_PEAK_PAD_SEC = 3.5;
/** 相邻高能时段间隔小于该值时并成一段。 */
export const VISION_MERGE_GAP_SEC = 10;
/** 单表研判超时;总预算见 budgetMs(默认 180s,超预算带着已得结果收工)。 */
export const VISION_CALL_TIMEOUT_MS = 60_000;
const VISION_BUDGET_MS = 180_000;
/** 成功研判帧数低于该值时证据太薄,宁可不给信号也不给噪声。 */
const MIN_SCORED_FRAMES = 3;

export interface VisionConfig {
  baseUrl: string;
  model: string;
}

export interface VisionStats {
  /** 计划抽帧数。 */
  framesTotal: number;
  /** 实际成功研判帧数。 */
  framesScored: number;
  /** 圈出的画面高能时段数。 */
  peakCount: number;
}

export interface VisionOutcome {
  visualPeaks: TimeRange[];
  stats: VisionStats;
}

/** 与 chatComplete 同思路的注入点,多带一张 jpeg(base64)。 */
export type VisionChatFn = (
  llm: LlmConfig,
  system: string,
  userText: string,
  imageBase64Jpeg: string,
  signal?: AbortSignal
) => Promise<string>;

/** 接触表拼图注入点(times → base64 jpeg;失败 null)。 */
export type SheetComposer = (videoPath: string, times: number[]) => Promise<string | null>;

/**
 * 规划抽帧时刻:先取信号窗口中点(按时间序),再用均匀网格补满额度;
 * 全程保持最小间隔,并夹在 [0.5, duration-0.5] 内。纯函数。
 */
export function planFrameTimes(
  durationSec: number,
  signals: MediaSignals | undefined,
  maxFrames = VISION_MAX_FRAMES,
  minSpacingSec = VISION_MIN_SPACING_SEC
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
  // 信号窗口中点优先——那里"可能有画面"的先验最强
  const priority = [...(signals?.loudPeaks ?? []), ...(signals?.cutDense ?? [])]
    .map((r) => (r.startSec + r.endSec) / 2)
    .sort((a, b) => a - b);
  for (const t of priority) tryPick(t);
  // 均匀网格补满剩余额度,防"信号盲区"整段漏掉
  for (let i = 1; i <= maxFrames; i++) tryPick((durationSec * i) / (maxFrames + 1));
  return picked.sort((a, b) => a - b);
}

/**
 * 解析接触表批量研判输出:{"cells":[{"i":1,"energy":0-10,"note":"…"}…]}。
 * 只收 1..cellCount 内的合法格(重复取首个,energy 夹回 0-10);
 * 一个合法格都没有(垃圾输出)返回 null。
 */
export function parseSheetVerdicts(
  content: string,
  cellCount: number
): Array<{ i: number; energy: number; note: string }> | null {
  const cleaned = stripThinkBlocks(content);
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const cells = (obj as { cells?: unknown }).cells;
  if (!Array.isArray(cells)) return null;
  const seen = new Set<number>();
  const out: Array<{ i: number; energy: number; note: string }> = [];
  for (const c of cells) {
    const rec = c as { i?: unknown; energy?: unknown; note?: unknown };
    const i = Number(rec.i);
    const energy = Number(rec.energy);
    if (!Number.isInteger(i) || i < 1 || i > cellCount || seen.has(i)) continue;
    if (!Number.isFinite(energy)) continue;
    seen.add(i);
    out.push({
      i,
      energy: Math.max(0, Math.min(10, energy)),
      note: typeof rec.note === "string" ? rec.note.trim().slice(0, 40) : "",
    });
  }
  return out.length > 0 ? out : null;
}

/** 高能帧 → 时段(±pad),按间隔并段,夹进 [0, duration]。纯函数。 */
export function visualPeakRanges(
  scored: Array<{ t: number; energy: number }>,
  durationSec: number,
  threshold = VISION_ENERGY_THRESHOLD,
  padSec = VISION_PEAK_PAD_SEC,
  mergeGapSec = VISION_MERGE_GAP_SEC
): TimeRange[] {
  const hits = scored
    .filter((s) => s.energy >= threshold)
    .map((s) => ({
      startSec: Math.max(0, s.t - padSec),
      endSec: Math.min(durationSec, s.t + padSec),
    }))
    .sort((a, b) => a.startSec - b.startSec);
  const out: TimeRange[] = [];
  for (const h of hits) {
    const last = out[out.length - 1];
    if (last && h.startSec - last.endSec < mergeGapSec) {
      last.endSec = Math.max(last.endSec, h.endSec);
    } else {
      out.push({ ...h });
    }
  }
  return out;
}

export function visionSystemPrompt(cellCount: number): string {
  return [
    `你在为短视频切片评估画面的"爆点能量"。图是 ${cellCount} 帧拼成的接触表,`,
    "从左到右、从上到下编号 1 起(每格左上角有白色序号;多余黑格忽略)。",
    "逐格打分 energy 0-10:夸张表情/激烈肢体动作/多人冲突或互动高潮/醒目道具或文字梗/场面炸裂给高分;",
    "静态口播、空镜、PPT、普通对坐聊天给低分(0-3)。",
    `严格只输出 JSON:{"cells":[{"i":1,"energy":0-10,"note":"≤15字画面描述"}…]},共 ${cellCount} 项,不要输出其他内容。`,
  ].join("\n");
}

/** 接触表的用户提示:报出每格对应的片内时刻,帮模型对齐语境。 */
export function sheetUserPrompt(times: number[]): string {
  const clock = (t: number): string => {
    const s = Math.floor(t);
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };
  return `逐格评估画面爆点能量。各格时刻:${times.map((t, i) => `${i + 1}=${clock(t)}`).join(" ")}`;
}

/** 默认研判实现:OpenAI 兼容多模态 chat(Ollama /v1 同样支持 image_url)。 */
export const visionChatComplete: VisionChatFn = async (llm, system, userText, imageBase64Jpeg, signal) => {
  const url = `${llm.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${llm.apiKey}` },
    body: JSON.stringify({
      model: llm.model,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64Jpeg}` } },
          ],
        },
      ],
      temperature: 0.2,
      max_tokens: 300,
    }),
    signal,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`vision HTTP ${res.status}: ${text.slice(0, 200)}`);
  const data = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("vision empty response");
  return content;
};

/**
 * 采集视觉爆点信号(接触表批量:九帧一张九宫格,一次调用出九个分)。
 * fail-open:
 * - 单表拼图/研判失败 → 跳过该表继续;
 * - 成功帧不足 MIN_SCORED_FRAMES → 返回 null(证据太薄不给信号);
 * - 超总预算 → 停止研判,用已得的帧收工;
 * - 上游 AbortSignal 取消 → 原样上抛(整个检测要停)。
 */
export async function collectVisionSignal(opts: {
  videoPath: string;
  durationSec: number;
  config: VisionConfig;
  signals?: MediaSignals;
  signal?: AbortSignal;
  /** 序号标注字体文件(默认拼图用;缺省不烧序号)。 */
  fontFile?: string;
  composeSheet?: SheetComposer;
  chat?: VisionChatFn;
  budgetMs?: number;
}): Promise<VisionOutcome | null> {
  const {
    videoPath, durationSec, config, signals, signal,
    composeSheet = (v, ts) => composeContactSheetJpeg(v, ts, { fontFile: opts.fontFile }),
    chat = visionChatComplete,
    budgetMs = VISION_BUDGET_MS,
  } = opts;
  const times = planFrameTimes(durationSec, signals);
  if (times.length === 0) return null;
  const llm: LlmConfig = { baseUrl: config.baseUrl, apiKey: "ollama", model: config.model };
  const deadline = Date.now() + budgetMs;
  const scored: Array<{ t: number; energy: number }> = [];
  for (const group of chunkCells(times)) {
    if (signal?.aborted) throw new Error("aborted");
    if (Date.now() > deadline) break; // 预算耗尽,带着已得结果收工
    const sheet = await composeSheet(videoPath, group);
    if (!sheet) continue;
    try {
      const timeout = AbortSignal.timeout(Math.max(1, Math.min(VISION_CALL_TIMEOUT_MS, deadline - Date.now())));
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const content = await chat(llm, visionSystemPrompt(group.length), sheetUserPrompt(group), sheet, combined);
      const verdicts = parseSheetVerdicts(content, group.length);
      if (verdicts) {
        for (const v of verdicts) scored.push({ t: group[v.i - 1], energy: v.energy });
      }
    } catch (e) {
      if (signal?.aborted) throw e; // 上游主动取消要中断整个检测
      // 其余错误跳过该表(端点冷启动/单表超时都不致命)
    }
  }
  if (scored.length < MIN_SCORED_FRAMES) return null;
  const visualPeaks = visualPeakRanges(scored, durationSec);
  return {
    visualPeaks,
    stats: { framesTotal: times.length, framesScored: scored.length, peakCount: visualPeaks.length },
  };
}
