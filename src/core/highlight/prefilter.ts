/**
 * 端侧两级漏斗·第一级:本地小模型(Ollama 等 OpenAI 兼容端点)先通读全文,
 * 圈出「可能有爆点」的句子区间;云端大模型只精读入围部分(第二级)。
 * 长视频的云端 token 花费降一个量级。铁律 fail-open:本地端点不可达、
 * 超时、输出不可解析,一律静默回退全文直发——漏斗只省钱,不背锅。
 */
import type { Transcript, TranscriptSegment } from "../transcribe/types";
import type { LlmConfig, FunnelStats } from "../../shared/api-types";
import { isChineseTranscript } from "./prompt";

/** 全文低于这个字符数不启用漏斗——短稿直发云端反而更准更快。 */
export const PREFILTER_MIN_CHARS = 3000;
/** 每块喂给小模型的目标字符数(小模型上下文短,块要小)。 */
export const CHUNK_TARGET_CHARS = 2600;
/** 入围窗口每侧扩展的句数(给云端留上下文,防止把钩子的铺垫切没)。 */
export const WINDOW_PAD_SEGMENTS = 2;
/** 整个初筛的总时限;超时回退全文(本地模型慢不能拖垮整条链路)。 */
export const PREFILTER_TIMEOUT_MS = 120_000;

/** 与 chatComplete 同形的注入点(避免与 detect.ts 循环依赖,也方便测试)。 */
export type ChatFn = (llm: LlmConfig, system: string, user: string, signal?: AbortSignal) => Promise<string>;

/** 按累计字符数把逐句稿切块(整句为单位,不拆句)。 */
export function chunkSegments(segments: TranscriptSegment[], targetChars = CHUNK_TARGET_CHARS): TranscriptSegment[][] {
  const chunks: TranscriptSegment[][] = [];
  let cur: TranscriptSegment[] = [];
  let chars = 0;
  for (const s of segments) {
    if (cur.length > 0 && chars + s.text.length > targetChars) {
      chunks.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(s);
    chars += s.text.length;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

/** 剥掉思考块(qwen3 等推理小模型会先输出 <think>…</think> 再给 JSON)。 */
export function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

export interface IdWindow {
  start: number;
  end: number;
}

/** 解析小模型输出的入围区间;只留两端 id 都真实存在的窗口。 */
export function parseWindows(content: string, validIds: Set<number>): IdWindow[] {
  let parsed: unknown;
  try {
    const cleaned = stripThinkBlocks(content);
    const brace = cleaned.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(brace ? brace[0] : cleaned);
  } catch {
    throw new Error("prefilter returned unparseable output");
  }
  const windows = (parsed as { windows?: unknown[] })?.windows;
  if (!Array.isArray(windows)) throw new Error("prefilter output missing windows array");
  const out: IdWindow[] = [];
  for (const w of windows) {
    if (typeof w !== "object" || w === null) continue;
    const r = w as Record<string, unknown>;
    let start = Number(r.start);
    let end = Number(r.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (start > end) [start, end] = [end, start];
    if (!validIds.has(start) || !validIds.has(end)) continue;
    out.push({ start, end });
  }
  return out;
}

/**
 * 窗口整理:按全稿句序每侧外扩 pad 句(id 可能不连续,按位置扩),
 * 然后合并重叠/相邻窗口,输出入围句 id 集合。
 */
export function expandAndMergeWindows(
  windows: IdWindow[],
  orderedIds: number[],
  padSegments = WINDOW_PAD_SEGMENTS
): Set<number> {
  const pos = new Map(orderedIds.map((id, i) => [id, i]));
  const kept = new Set<number>();
  for (const w of windows) {
    const a = pos.get(w.start);
    const b = pos.get(w.end);
    if (a === undefined || b === undefined) continue;
    const from = Math.max(0, Math.min(a, b) - padSegments);
    const to = Math.min(orderedIds.length - 1, Math.max(a, b) + padSegments);
    for (let i = from; i <= to; i++) kept.add(orderedIds[i]);
  }
  return kept;
}

/** 只保留入围句的转写(id 原样保留——云端引用的 id 仍能在全稿反查)。 */
export function filterTranscriptByIds(transcript: Transcript, keptIds: Set<number>): Transcript {
  return { ...transcript, segments: transcript.segments.filter((s) => keptIds.has(s.id)) };
}

export function funnelStats(full: Transcript, filtered: Transcript): FunnelStats {
  const chars = (t: Transcript): number => t.segments.reduce((n, s) => n + s.text.length, 0);
  return {
    totalSegments: full.segments.length,
    keptSegments: filtered.segments.length,
    totalChars: chars(full),
    keptChars: chars(filtered),
  };
}

/** 初筛系统提示:任务窄、输出形状极简——小模型才啃得动。 */
export function prefilterSystemPrompt(zh: boolean): string {
  return zh
    ? `你是短视频切片的初筛员。给你长视频逐句稿的一部分,格式每行 [句id] 内容。找出「可能剪成爆款切片」的句子区间:有冲突/悬念/金句/情绪爆发/反转/干货的地方。宁多勿漏——你圈出的区间会交给更强的模型精挑,漏掉的永远消失。每个区间 2~10 句。严格只输出 JSON:{"windows":[{"start":起始句id,"end":结束句id}]}。没有值得圈的就输出 {"windows":[]}。不要输出任何其他文字。`
    : `You are a first-pass screener for short-video clipping. You get part of a long-video transcript, one line per sentence: [id] text. Mark sentence ranges that COULD become viral clips: conflict, suspense, quotable lines, emotional peaks, twists, dense insight. Over-include rather than miss — your ranges go to a stronger model for final picking; anything you skip is gone forever. Each range spans 2-10 sentences. Output STRICT JSON only: {"windows":[{"start":firstId,"end":lastId}]}. If nothing qualifies output {"windows":[]}. No other text.`;
}

/** 每块的用户提示。qwen3 系列附加 /no_think 关闭思考流(其他模型不加)。 */
export function prefilterUserPrompt(chunk: TranscriptSegment[], zh: boolean, model: string): string {
  const lines = chunk.map((s) => `[${s.id}] ${s.text}`).join("\n");
  const noThink = /qwen3/i.test(model) ? "\n/no_think" : "";
  return (zh ? `逐句稿如下:\n${lines}` : `Transcript chunk:\n${lines}`) + noThink;
}

export interface PrefilterOutcome {
  transcript: Transcript;
  funnel: FunnelStats;
}

/**
 * 跑完整个第一级漏斗。返回 null 表示「不启用/不可信,请用全文」:
 * 稿太短、端点全挂、超时、或小模型声称全文毫无爆点(不可信,宁可花钱不漏)。
 * 单块失败不致命——那一块整块入围(fail-open 到「多花点钱」而不是「漏内容」)。
 */
export async function prefilterTranscript(
  transcript: Transcript,
  local: LlmConfig,
  chat: ChatFn,
  signal?: AbortSignal
): Promise<PrefilterOutcome | null> {
  const totalChars = transcript.segments.reduce((n, s) => n + s.text.length, 0);
  if (totalChars < PREFILTER_MIN_CHARS) return null;

  const zh = isChineseTranscript(transcript);
  const chunks = chunkSegments(transcript.segments);
  const orderedIds = transcript.segments.map((s) => s.id);
  const validIds = new Set(orderedIds);
  const system = prefilterSystemPrompt(zh);

  // 总时限 + 上游取消信号合成;超时让所有在途请求一起终止
  const timeout = AbortSignal.timeout(PREFILTER_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let anySucceeded = false;
  const windows: IdWindow[] = [];
  const results = await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const content = await chat(local, system, prefilterUserPrompt(chunk, zh, local.model), combined);
        return { chunk, windows: parseWindows(content, validIds) };
      } catch {
        // 单块失败 → 整块入围,交给云端(贵一点,但绝不漏内容)
        return { chunk, windows: [{ start: chunk[0].id, end: chunk[chunk.length - 1].id }], failed: true };
      }
    })
  );
  for (const r of results) {
    if (!("failed" in r && r.failed)) anySucceeded = true;
    windows.push(...r.windows);
  }
  // 上游主动取消要往外抛,不能吞成"回退全文"
  if (signal?.aborted) throw new Error("detection cancelled");
  if (!anySucceeded) return null; // 端点整体不可用 → 漏斗不生效
  if (windows.length === 0) return null; // 小模型判"全无爆点"不可信 → 全文直发

  const keptIds = expandAndMergeWindows(windows, orderedIds);
  const filtered = filterTranscriptByIds(transcript, keptIds);
  // 没筛掉多少(≥85% 保留)就不值得走漏斗,直接全文——统计上也诚实
  if (filtered.segments.length >= transcript.segments.length * 0.85) return null;
  return { transcript: filtered, funnel: funnelStats(transcript, filtered) };
}
