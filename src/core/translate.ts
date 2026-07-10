/**
 * 双语字幕翻译:把切片覆盖的整句(segment)批量翻译成目标语言,作为独立的
 * 小号翻译轨与原文字幕同屏烧录——短视频出海的标配形态(原文卡拉OK在上,
 * 译文整句在下)。
 *
 * 按整句而非字幕行翻译:句子有完整语境,译文质量高,也天然不受逐词换行
 * 与跳剪重排的影响。全程 fail-open:翻译失败/缺句都只是"这句没有译文",
 * 绝不拖垮导出。纯函数(收集/解析/裁剪/重映射)可单测;LLM 调用注入。
 */
import type { LlmConfig, Transcript } from "../shared/api-types";
import type { KeptSegment } from "./gaps";
import { stripThinkBlocks } from "./highlight/prefilter";

/** 单块翻译请求的字符上限(整句为单位切块)。 */
export const TRANSLATE_CHUNK_CHARS = 1800;
/** 单块翻译超时。 */
export const TRANSLATE_TIMEOUT_MS = 90_000;
/** 短于该秒数的译文行不值得闪一下(重映射后可能被跳剪掐得只剩一瞬)。 */
const MIN_LINE_SEC = 0.3;

/** 一条译文行(时间基与同路字幕词一致:无跳剪为源片绝对时间)。 */
export interface TranslationLine {
  startSec: number;
  endSec: number;
  text: string;
}

/** 待翻译的整句(id 取转写 segment id,跨块全局唯一)。 */
export interface TranslatableSegment {
  id: number;
  startSec: number;
  endSec: number;
  text: string;
}

/** 与 detect.ts 的 chatComplete 同形的注入点。 */
export type TranslateChatFn = (llm: LlmConfig, system: string, user: string, signal?: AbortSignal) => Promise<string>;

/** 收集所有切片覆盖的句子(按 segment 去重;pad 容纳导出时的镜头吸附位移)。 */
export function collectClipSegments(
  transcript: Transcript,
  clips: Array<{ startSec: number; endSec: number }>,
  padSec = 1.5
): TranslatableSegment[] {
  const out: TranslatableSegment[] = [];
  const seen = new Set<number>();
  for (const seg of transcript.segments) {
    if (seen.has(seg.id) || !seg.text.trim()) continue;
    const hit = clips.some((c) => seg.endSec > c.startSec - padSec && seg.startSec < c.endSec + padSec);
    if (hit) {
      seen.add(seg.id);
      out.push({ id: seg.id, startSec: seg.startSec, endSec: seg.endSec, text: seg.text.trim() });
    }
  }
  return out;
}

const LANG_LABEL: Record<string, string> = { en: "英文", zh: "中文" };

export function translationSystemPrompt(targetLang: string): string {
  const label = LANG_LABEL[targetLang] ?? targetLang;
  return [
    `你是短视频字幕翻译员。把每一句口语字幕翻译成${label}。`,
    "要求:口语化、简短有力、适合字幕阅读;保留语气和数字;品牌名/专有名词不硬translate;不要加解释。",
    '严格只输出 JSON:{"lines":[{"id":1,"text":"译文"}]},id 与输入一一对应,不要输出其他内容。',
  ].join("\n");
}

export function translationUserPrompt(segments: TranslatableSegment[]): string {
  return segments.map((s) => `[${s.id}] ${s.text}`).join("\n");
}

/** 解析翻译输出 → id→译文;垃圾输出返回空 Map(fail-open 到"没有译文")。 */
export function parseTranslationLines(content: string, validIds: Set<number>): Map<number, string> {
  const out = new Map<number, string>();
  const cleaned = stripThinkBlocks(content);
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return out;
  let obj: unknown;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return out;
  }
  const lines = (obj as { lines?: unknown }).lines;
  if (!Array.isArray(lines)) return out;
  for (const l of lines) {
    const rec = l as { id?: unknown; text?: unknown };
    const id = Number(rec.id);
    if (Number.isInteger(id) && validIds.has(id) && typeof rec.text === "string" && rec.text.trim()) {
      out.set(id, rec.text.trim());
    }
  }
  return out;
}

/** 按字符预算把句子切块(整句为单位)。 */
export function chunkForTranslate(segments: TranslatableSegment[], targetChars = TRANSLATE_CHUNK_CHARS): TranslatableSegment[][] {
  const chunks: TranslatableSegment[][] = [];
  let cur: TranslatableSegment[] = [];
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

/**
 * 批量翻译。逐块调用,单块失败只丢那一块的译文(fail-open);
 * 全部失败返回 null(调用方据此在回执里写明没翻译)。上游取消原样上抛。
 */
export async function translateSegments(
  segments: TranslatableSegment[],
  targetLang: string,
  llm: LlmConfig,
  chat: TranslateChatFn,
  signal?: AbortSignal
): Promise<Map<number, string> | null> {
  if (segments.length === 0) return null;
  const system = translationSystemPrompt(targetLang);
  const result = new Map<number, string>();
  let anySucceeded = false;
  for (const chunk of chunkForTranslate(segments)) {
    try {
      const timeout = AbortSignal.timeout(TRANSLATE_TIMEOUT_MS);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const content = await chat(llm, system, translationUserPrompt(chunk), combined);
      const parsed = parseTranslationLines(content, new Set(chunk.map((s) => s.id)));
      if (parsed.size > 0) anySucceeded = true;
      for (const [id, text] of parsed) result.set(id, text);
    } catch (e) {
      if (signal?.aborted) throw e; // 上游主动取消要中断整个导出
      // 该块没有译文,继续下一块
    }
  }
  return anySucceeded ? result : null;
}

/** 取落在切片内的句子译文行,时间夹进切片范围(源片绝对时间)。 */
export function clipTranslationLines(
  segments: TranslatableSegment[],
  translations: Map<number, string>,
  clipStartSec: number,
  clipEndSec: number
): TranslationLine[] {
  const out: TranslationLine[] = [];
  for (const s of segments) {
    const text = translations.get(s.id);
    if (!text) continue;
    if (s.endSec <= clipStartSec || s.startSec >= clipEndSec) continue;
    const startSec = Math.max(s.startSec, clipStartSec);
    const endSec = Math.min(s.endSec, clipEndSec);
    if (endSec - startSec >= MIN_LINE_SEC) out.push({ startSec, endSec, text });
  }
  return out;
}

/** 把译文行夹进(可能被镜头吸附移动过的)最终切片范围,太短的丢弃。 */
export function clampTranslationLines(lines: TranslationLine[], clipStartSec: number, clipEndSec: number): TranslationLine[] {
  const out: TranslationLine[] = [];
  for (const l of lines) {
    const startSec = Math.max(l.startSec, clipStartSec);
    const endSec = Math.min(l.endSec, clipEndSec);
    if (endSec - startSec >= MIN_LINE_SEC) out.push({ startSec, endSec, text: l.text });
  }
  return out;
}

/**
 * 跳剪重映射:把源时间的译文行映射到压缩后的输出时间轴。
 * 一行可能被剪掉中段——保守做法是取该行与各保留段交集的首尾,
 * 完全落在被剪区间里的行直接丢弃。
 */
export function remapTranslationLines(lines: TranslationLine[], kept: KeptSegment[]): TranslationLine[] {
  const out: TranslationLine[] = [];
  for (const line of lines) {
    let outStart: number | null = null;
    let outEnd: number | null = null;
    let offset = 0;
    for (const seg of kept) {
      const from = Math.max(line.startSec, seg.startSec);
      const to = Math.min(line.endSec, seg.endSec);
      if (to > from) {
        const os = offset + (from - seg.startSec);
        const oe = offset + (to - seg.startSec);
        if (outStart === null) outStart = os;
        outEnd = oe;
      }
      offset += seg.endSec - seg.startSec;
    }
    if (outStart !== null && outEnd !== null && outEnd - outStart >= MIN_LINE_SEC) {
      out.push({ startSec: outStart, endSec: outEnd, text: line.text });
    }
  }
  return out;
}
