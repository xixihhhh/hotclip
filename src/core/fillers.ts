/**
 * Filler-word & stutter detection: find the spans a tight human edit would
 * drop — hesitation sounds and immediate word repeats. Deliberately
 * conservative: only unambiguous hesitation tokens make the list ("然后/那个"
 * are usually real words; sentence-final "啊" carries emotion — keep them).
 * Pure functions; the spans feed the jump-cut planner as forced cuts.
 */
import type { TranscriptWord } from "../shared/api-types";
import type { KeptSegment } from "./gaps";

/** Unambiguous hesitation tokens (standalone words only). */
const FILLER_TOKENS = new Set([
  "嗯", "呃", "额", "唔", "嗯嗯", "呃呃",
  "um", "uh", "er", "erm", "hmm", "mmm",
]);

/** Stutter repeats longer than this are probably deliberate emphasis. */
const STUTTER_MAX_SEC = 0.8;

export interface FillerHit {
  index: number;
  text: string;
  startSec: number;
  endSec: number;
  kind: "filler" | "stutter";
}

/** Strip punctuation the punctuation-restore step may have attached. */
function bareToken(text: string): string {
  return text.toLowerCase().replace(/[,。,.!?!?、;;::…~~\s]/gu, "");
}

/** Find filler words and stutter repeats (the FIRST of each repeat pair). */
export function findFillerWords(words: TranscriptWord[]): FillerHit[] {
  const hits: FillerHit[] = [];
  for (let i = 0; i < words.length; i++) {
    const token = bareToken(words[i].text);
    if (!token) continue;
    if (FILLER_TOKENS.has(token)) {
      hits.push({ index: i, text: words[i].text, startSec: words[i].startSec, endSec: words[i].endSec, kind: "filler" });
      continue;
    }
    const next = words[i + 1];
    if (
      next &&
      token === bareToken(next.text) &&
      words[i].endSec - words[i].startSec < STUTTER_MAX_SEC &&
      next.startSec - words[i].endSec < 0.35
    ) {
      hits.push({ index: i, text: words[i].text, startSec: words[i].startSec, endSec: words[i].endSec, kind: "stutter" });
    }
  }
  return hits;
}

/** Words minus the flagged indices (captions must not show what was cut). */
export function dropFillerWords(words: TranscriptWord[], hits: FillerHit[]): TranscriptWord[] {
  const drop = new Set(hits.map((h) => h.index));
  return words.filter((_, i) => !drop.has(i));
}

/** Merge overlapping/adjacent hit spans into forced-cut intervals. */
export function fillerCutSpans(hits: FillerHit[], mergeGapSec = 0.1): KeptSegment[] {
  const sorted = [...hits].sort((a, b) => a.startSec - b.startSec);
  const out: KeptSegment[] = [];
  for (const h of sorted) {
    const last = out[out.length - 1];
    if (last && h.startSec - last.endSec < mergeGapSec) {
      last.endSec = Math.max(last.endSec, h.endSec);
    } else {
      out.push({ startSec: h.startSec, endSec: h.endSec });
    }
  }
  return out;
}
