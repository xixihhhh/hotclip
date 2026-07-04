/**
 * Sentence segmentation: fold a timed token/word stream into sentence-level
 * segments. Pure function — engines feed it their raw tokens.
 *
 * Split priority: (1) hard sentence-final punctuation, (2) silence gaps
 * between tokens, (3) a max-length guard so a punctuation-less livestream
 * rant still becomes editable chunks.
 */
import type { TranscriptWord, TranscriptSegment } from "./types";

const HARD_PUNCT = /[。！？.!?…]$/;
const SOFT_PUNCT = /[，、;；,]$/;

export interface SegmentOptions {
  /** Silence gap (seconds) that forces a split even without punctuation. */
  gapSec?: number;
  /** Hard cap on segment duration; long run-ons split at the nearest soft punct/word. */
  maxSec?: number;
}

/** True when the joined text is CJK-dominant (affects join separator). */
function isCjkDominant(words: TranscriptWord[]): boolean {
  let cjk = 0;
  let total = 0;
  for (const w of words) {
    for (const ch of w.text) {
      total++;
      if (/[一-鿿぀-ヿ가-힣]/.test(ch)) cjk++;
    }
  }
  return total > 0 && cjk / total > 0.5;
}

/** Join word texts: CJK concatenates, latin joins with spaces. */
export function joinWords(words: TranscriptWord[]): string {
  if (words.length === 0) return "";
  if (isCjkDominant(words)) {
    return words.map((w) => w.text).join("").trim();
  }
  return words
    .map((w) => w.text)
    .join(" ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Fold timed words into sentence segments. */
export function segmentWords(words: TranscriptWord[], options: SegmentOptions = {}): TranscriptSegment[] {
  const gapSec = options.gapSec ?? 0.8;
  const maxSec = options.maxSec ?? 12;
  const segments: TranscriptSegment[] = [];
  let bucket: TranscriptWord[] = [];

  const flush = (): void => {
    if (bucket.length === 0) return;
    const text = joinWords(bucket);
    if (text) {
      segments.push({
        id: segments.length + 1,
        startSec: bucket[0].startSec,
        endSec: bucket[bucket.length - 1].endSec,
        text,
        words: bucket,
      });
    }
    bucket = [];
  };

  for (const word of words) {
    if (!word.text.trim()) continue;
    const prev = bucket[bucket.length - 1];

    // silence gap → close the previous sentence before adding this word
    if (prev && word.startSec - prev.endSec >= gapSec) {
      flush();
    }

    bucket.push(word);
    const started = bucket[0].startSec;

    if (HARD_PUNCT.test(word.text.trim())) {
      flush();
    } else if (word.endSec - started >= maxSec) {
      // run-on guard: prefer to break after a soft punctuation near the tail
      let cut = bucket.length;
      for (let i = bucket.length - 1; i > 0 && bucket[bucket.length - 1].endSec - bucket[i].endSec < 3; i--) {
        if (SOFT_PUNCT.test(bucket[i].text.trim())) {
          cut = i + 1;
          break;
        }
      }
      const rest = bucket.slice(cut);
      bucket = bucket.slice(0, cut);
      flush();
      bucket = rest;
    }
  }
  flush();
  return segments;
}
