/**
 * Reverse text matching: locate LLM-selected verbatim quotes in the timed
 * token stream to derive frame-accurate clip boundaries.
 *
 * Why: LLMs are unreliable at emitting timestamps but excellent at quoting
 * text. So the LLM returns quotes + segment-id ranges, and THIS module maps
 * them back onto token timings. Match ladder (best → worst):
 *   1. "exact"    — the full normalized quote found in the token stream
 *   2. "anchored" — start-quote and end-quote anchors both found
 *   3. "segment"  — fall back to the LLM's segment-id range boundaries
 */
import type { Transcript, TranscriptWord } from "../transcribe/types";
import { normalizePieces, PIECE_JOINER, type ClipPiece } from "../../shared/pieces";

/** Normalization: strip everything except letters/digits/CJK; lowercase latin. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

interface TokenIndexEntry {
  tokenIdx: number;
}

/** Flattened, normalized view of the transcript's token stream. */
export interface TokenIndex {
  words: TranscriptWord[];
  /** Concatenated normalized text of all tokens. */
  normalized: string;
  /** For each char of `normalized`, which token it came from. */
  charToToken: TokenIndexEntry[];
}

export function buildTokenIndex(words: TranscriptWord[]): TokenIndex {
  let normalized = "";
  const charToToken: TokenIndexEntry[] = [];
  words.forEach((w, tokenIdx) => {
    const n = normalizeText(w.text);
    normalized += n;
    for (let i = 0; i < n.length; i++) charToToken.push({ tokenIdx });
  });
  return { words, normalized, charToToken };
}

export interface MatchedRange {
  startSec: number;
  endSec: number;
  boundary: "exact" | "anchored";
}

/** Find a normalized needle in the index starting at/after fromChar; -1 if absent. */
function findFrom(index: TokenIndex, needle: string, fromChar: number): number {
  if (!needle) return -1;
  return index.normalized.indexOf(needle, fromChar);
}

/**
 * Extend an end-token index through trailing punctuation-only tokens.
 * Normalization erases punctuation, so a quote ending at "…这件事" would
 * otherwise cut BEFORE the "。" token and clip the sentence's last beat.
 */
function absorbTrailingPunct(words: TranscriptWord[], endTok: number): number {
  let i = endTok;
  while (i + 1 < words.length && normalizeText(words[i + 1].text) === "") i++;
  return i;
}

/**
 * Locate a full quote (verbatim selection) in the token stream.
 * Falls back to anchoring on the quote's head and tail when the middle
 * diverges (LLMs occasionally elide filler words when quoting long spans).
 */
export function matchQuote(
  index: TokenIndex,
  quoteStart: string,
  quoteEnd: string,
  searchFromSec = 0
): MatchedRange | null {
  const { words, charToToken } = index;
  if (words.length === 0) return null;

  // restrict search to tokens at/after searchFromSec (supports duplicate phrases)
  let fromChar = 0;
  if (searchFromSec > 0) {
    const firstTokenIdx = words.findIndex((w) => w.endSec > searchFromSec);
    if (firstTokenIdx > 0) {
      fromChar = charToToken.findIndex((e) => e.tokenIdx >= firstTokenIdx);
      if (fromChar < 0) fromChar = 0;
    }
  }

  const head = normalizeText(quoteStart);
  const tail = normalizeText(quoteEnd);
  if (!head && !tail) return null;

  // 1) exact: head+tail form one contiguous quote (common for short clips)
  if (head && tail) {
    const joined = head === tail ? head : head + tail;
    const at = findFrom(index, joined, fromChar);
    if (at >= 0) {
      const startTok = charToToken[at].tokenIdx;
      const endTok = absorbTrailingPunct(words, charToToken[at + joined.length - 1].tokenIdx);
      return { startSec: words[startTok].startSec, endSec: words[endTok].endSec, boundary: "exact" };
    }
  }

  // 2) anchored: find head, then tail after it
  const headAt = findFrom(index, head, fromChar);
  if (headAt < 0) return null;
  const startTok = charToToken[headAt].tokenIdx;
  if (!tail) {
    const endTok = absorbTrailingPunct(words, charToToken[headAt + head.length - 1].tokenIdx);
    return { startSec: words[startTok].startSec, endSec: words[endTok].endSec, boundary: "anchored" };
  }
  const tailAt = findFrom(index, tail, headAt + head.length);
  if (tailAt < 0) return null;
  const endTok = absorbTrailingPunct(words, charToToken[tailAt + tail.length - 1].tokenIdx);
  return { startSec: words[startTok].startSec, endSec: words[endTok].endSec, boundary: "anchored" };
}

/** 多片段拼接里的一段:定位方式与单段完全一样,只是没有标题/评分。 */
export interface RawPart {
  startSegmentId: number;
  endSegmentId: number;
  quoteStart: string;
  quoteEnd: string;
}

export interface RawSelection {
  title: string;
  hook: string;
  score: number;
  reason: string;
  startSegmentId: number;
  endSegmentId: number;
  quoteStart: string;
  quoteEnd: string;
  /** Verbatim in-clip keywords for caption emphasis (may be empty). */
  keywords: string[];
  /**
   * 多片段拼接:相隔很远的两三处内容拼成一条(「前后打脸」这类爆点的前提)。
   * 缺省即普通连续切片;解析不出至少两段时自动退回顶层 quote 的单段定位。
   */
  parts?: RawPart[];
}

export interface ResolvedRange {
  startSec: number;
  endSec: number;
  text: string;
  boundary: "exact" | "anchored" | "segment";
  /** 多片段拼接的段清单(≥2 段才有);startSec/endSec 是它的跨度首尾。 */
  pieces?: ClipPiece[];
}

/** 匹配质量排序:多段拼接取其中最差的那一段作为整条的质量标注。 */
const BOUNDARY_RANK: Record<ResolvedRange["boundary"], number> = { exact: 2, anchored: 1, segment: 0 };

/**
 * Resolve one LLM selection to timed boundaries.
 *
 * 先试多片段(sel.parts):逐段各自反查,规整后至少剩两段才算拼接成立;
 * 否则退回单段——顶层 quoteStart/quoteEnd 始终填着第一段开头/最后一段结尾,
 * 所以退化路径不会拿到空定位。
 */
export function resolveSelection(transcript: Transcript, sel: RawSelection): ResolvedRange | null {
  if (sel.parts && sel.parts.length >= 2) {
    const stitched = resolveParts(transcript, sel.parts);
    if (stitched) return stitched;
  }
  return resolveSingle(transcript, sel);
}

/** 逐段反查 + 规整;不足两段返回 null(调用方退回单段)。 */
function resolveParts(transcript: Transcript, parts: RawPart[]): ResolvedRange | null {
  const resolved = parts
    .map((p) => resolveSingle(transcript, p))
    .filter((r): r is ResolvedRange => r !== null);
  if (resolved.length < 2) return null;
  const pieces = normalizePieces(resolved.map((r) => ({ startSec: r.startSec, endSec: r.endSec })));
  if (pieces.length < 2) return null;
  const boundary = resolved.reduce<ResolvedRange["boundary"]>(
    (worst, r) => (BOUNDARY_RANK[r.boundary] < BOUNDARY_RANK[worst] ? r.boundary : worst),
    "exact"
  );
  return {
    startSec: pieces[0].startSec,
    endSec: pieces[pieces.length - 1].endSec,
    pieces,
    // 省略标记让评审和用户一眼看出「这里跳了」——拼接最大的风险就是断章取义
    text: pieces.map((p) => textBetween(transcript, p.startSec, p.endSec)).join(PIECE_JOINER),
    boundary,
  };
}

/** 单段定位(历史行为):引文优先,失败回退句 id 区间。 */
function resolveSingle(
  transcript: Transcript,
  sel: Pick<RawSelection, "startSegmentId" | "endSegmentId" | "quoteStart" | "quoteEnd">
): ResolvedRange | null {
  const segments = transcript.segments;
  if (segments.length === 0) return null;

  const startSeg = segments.find((s) => s.id === sel.startSegmentId) ?? null;
  const endSeg = segments.find((s) => s.id === sel.endSegmentId) ?? null;

  // words within the segment window (±1 segment slack), for scoped quote search
  const loIdx = startSeg ? Math.max(0, segments.indexOf(startSeg) - 1) : 0;
  const hiIdx = endSeg ? Math.min(segments.length - 1, segments.indexOf(endSeg) + 1) : segments.length - 1;
  const scopedWords = segments.slice(loIdx, hiIdx + 1).flatMap((s) => s.words);
  const scopedIndex = buildTokenIndex(scopedWords);

  const matched = matchQuote(scopedIndex, sel.quoteStart, sel.quoteEnd);
  if (matched) {
    const text = textBetween(transcript, matched.startSec, matched.endSec);
    return { ...matched, text };
  }

  // 3) segment fallback: trust the declared segment ids
  if (startSeg && endSeg && endSeg.endSec > startSeg.startSec) {
    return {
      startSec: startSeg.startSec,
      endSec: endSeg.endSec,
      text: segments
        .slice(segments.indexOf(startSeg), segments.indexOf(endSeg) + 1)
        .map((s) => s.text)
        .join(" "),
      boundary: "segment",
    };
  }
  return null;
}

/** Collect segment texts overlapping [startSec, endSec] for display. */
function textBetween(transcript: Transcript, startSec: number, endSec: number): string {
  return transcript.segments
    .filter((s) => s.endSec > startSec && s.startSec < endSec)
    .map((s) => s.text)
    .join(" ");
}
