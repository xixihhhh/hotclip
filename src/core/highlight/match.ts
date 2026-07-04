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

export interface RawSelection {
  title: string;
  hook: string;
  score: number;
  reason: string;
  startSegmentId: number;
  endSegmentId: number;
  quoteStart: string;
  quoteEnd: string;
}

export interface ResolvedRange {
  startSec: number;
  endSec: number;
  text: string;
  boundary: "exact" | "anchored" | "segment";
}

/**
 * Resolve one LLM selection to timed boundaries.
 * Quote matching is scoped to the declared segment range (± one segment of
 * slack) so identical catchphrases elsewhere in a livestream don't hijack it.
 */
export function resolveSelection(transcript: Transcript, sel: RawSelection): ResolvedRange | null {
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
