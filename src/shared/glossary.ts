/**
 * 热词词表:ASR 对人名/品牌/术语整场重复识别错,逐句手改改不过来。
 * 词表持久化「错词→对词」,转写完成后整词替换全片生效——解码期热词对
 * SenseVoice/Paraformer/FireRed 这类非 transducer 引擎不可用,文本层
 * 后替换是对四路引擎(含云端档)一视同仁的唯一通用路线。纯函数,可完整单测。
 *
 * 匹配规则:
 * - 拉丁词加词边界守卫(「AI」不动「MAIN」)且忽略大小写;CJK 直接子串匹配
 * - 多条同时命中取最长错词优先;单趟替换,替换结果不会被别的词条二次改写
 * - 被改句的词级时间轴按字宽重建(复用逐句即点即改的管线),卡拉OK不失真
 */
import type { GlossaryEntry, Transcript, TranscriptSegment } from "./api-types";
import { rebuildWords } from "./edit-transcript";

const LATIN_RE = /[A-Za-z0-9]/;
const CJK_RE = /[一-鿿぀-ヿ가-힯]/;

/** 容错解析持久化/IPC 来源的词表:去空白、丢弃无效项与自指项。 */
export function sanitizeGlossary(raw: unknown): GlossaryEntry[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: GlossaryEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const wrong = typeof (item as GlossaryEntry).wrong === "string" ? (item as GlossaryEntry).wrong.trim() : "";
    const right = typeof (item as GlossaryEntry).right === "string" ? (item as GlossaryEntry).right.trim() : "";
    if (!wrong || !right || wrong === right) continue;
    const key = wrong.toLowerCase();
    if (seen.has(key)) continue; // 同一错词只留第一条
    seen.add(key);
    out.push({ wrong, right });
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 单个错词的匹配片段:拉丁首尾加词边界守卫,防止误伤更长的词。 */
function entryPattern(wrong: string): string {
  const head = LATIN_RE.test(wrong[0]) ? "(?<![A-Za-z0-9])" : "";
  const tail = LATIN_RE.test(wrong[wrong.length - 1]) ? "(?![A-Za-z0-9])" : "";
  return `${head}${escapeRegExp(wrong)}${tail}`;
}

/**
 * 对一段文本应用词表。长错词优先(alternation 按长度降序),整体单趟
 * 替换——某条的替换结果绝不会再被另一条命中。拉丁匹配忽略大小写。
 */
export function applyGlossaryToText(text: string, entries: GlossaryEntry[]): string {
  const list = sanitizeGlossary(entries);
  if (list.length === 0 || !text) return text;
  const sorted = [...list].sort((a, b) => b.wrong.length - a.wrong.length);
  const byKey = new Map(sorted.map((e) => [e.wrong.toLowerCase(), e.right]));
  const re = new RegExp(sorted.map((e) => entryPattern(e.wrong)).join("|"), "giu");
  return text.replace(re, (m) => byKey.get(m.toLowerCase()) ?? m);
}

export interface GlossaryApplyResult {
  transcript: Transcript;
  /** 被修正的句数;0 表示 transcript 原引用未动。 */
  replaced: number;
}

/**
 * 对整份转写应用词表:仅重建被改到的句(词级时间轴按字宽重建,保留说话人
 * 标注),其余句保持原引用;一句没改则原样返回同一个 transcript 引用。
 */
export function applyGlossaryToTranscript(transcript: Transcript, entries: GlossaryEntry[]): GlossaryApplyResult {
  const list = sanitizeGlossary(entries);
  if (list.length === 0) return { transcript, replaced: 0 };
  let replaced = 0;
  const segments = transcript.segments.map((seg): TranscriptSegment => {
    const text = applyGlossaryToText(seg.text, list);
    if (text === seg.text) return seg;
    replaced++;
    const words = rebuildWords(text, seg.startSec, seg.endSec).map((w) =>
      seg.speaker !== undefined ? { ...w, speaker: seg.speaker } : w
    );
    return { ...seg, text, words, glossaryApplied: true };
  });
  if (replaced === 0) return { transcript, replaced: 0 };
  return { transcript: { ...transcript, segments }, replaced };
}

/** 命中句数统计(「应用到全片(N 处)」的 N)。 */
export function countGlossaryHits(transcript: Transcript, entries: GlossaryEntry[]): number {
  const list = sanitizeGlossary(entries);
  if (list.length === 0) return 0;
  let n = 0;
  for (const seg of transcript.segments) {
    if (applyGlossaryToText(seg.text, list) !== seg.text) n++;
  }
  return n;
}

/** 词条长度上限:超过视为整句改写而非术语纠错,不提词表。 */
const MAX_TERM_LEN = 16;

/**
 * 从「改前→改后」两句文本里提取一条「错词→对词」候选:掐掉最长公共
 * 前后缀,再把边界外扩到拉丁词整词。纯插入/纯删除/改动过长(整句重写)
 * 都返回 null——那些不是术语纠错。
 */
export function diffReplacement(oldText: string, newText: string): GlossaryEntry | null {
  const a = Array.from(oldText.trim());
  const b = Array.from(newText.trim());
  if (a.join("") === b.join("")) return null;
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  // 边界外扩:别把拉丁词切一半("colour"→"color" 应得整词而非 "u"→"")
  while (p > 0 && LATIN_RE.test(a[p - 1]) && (LATIN_RE.test(a[p] ?? "") || LATIN_RE.test(b[p] ?? ""))) p--;
  while (
    s > 0 &&
    LATIN_RE.test(a[a.length - s]) &&
    (LATIN_RE.test(a[a.length - 1 - s] ?? "") || LATIN_RE.test(b[b.length - 1 - s] ?? ""))
  )
    s--;
  // 拉丁扩词后仍有一侧为空 = 纯插入/纯删除(非拼写修正),不当词条
  if (a.length - s - p === 0 || b.length - s - p === 0) return null;
  // 单字词条太危险(「川」会误伤「四川」):把相邻的 CJK 公共字回拉进词条,
  // 直到两侧都至少两字——「川普→特朗普」而非「川→特朗」
  while ((a.length - s - p < 2 || b.length - s - p < 2) && s > 0 && CJK_RE.test(a[a.length - s])) s--;
  while ((a.length - s - p < 2 || b.length - s - p < 2) && p > 0 && CJK_RE.test(a[p - 1])) p--;
  const wrong = a.slice(p, a.length - s).join("").trim();
  const right = b.slice(p, b.length - s).join("").trim();
  if (!wrong || !right || wrong === right) return null;
  if (wrong.length > MAX_TERM_LEN || right.length > MAX_TERM_LEN) return null;
  return { wrong, right };
}

/** 把一条词条并入词表:同错词(忽略大小写)覆盖旧对词,其余追加。 */
export function upsertGlossaryEntry(entries: GlossaryEntry[], entry: GlossaryEntry): GlossaryEntry[] {
  const list = sanitizeGlossary(entries);
  const add = sanitizeGlossary([entry]);
  if (add.length === 0) return list;
  const key = add[0].wrong.toLowerCase();
  const rest = list.filter((e) => e.wrong.toLowerCase() !== key);
  return [...rest, add[0]];
}
