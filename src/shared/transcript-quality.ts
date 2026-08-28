import type { ClipPiece, TimingQualitySpan, TranscriptWord, WordTimingSource } from "./api-types";
import { wordsInPieces } from "./pieces";

const UNCERTAIN_SOURCES = new Set<WordTimingSource>(["interpolated", "edited", "estimated"]);

export interface TimingQualitySummary {
  totalWords: number;
  uncertainWords: number;
  sourceCounts: Partial<Record<WordTimingSource | "legacy", number>>;
  uncertainSpans: TimingQualitySpan[];
}

export function isUncertainTiming(word: Pick<TranscriptWord, "timingSource">): boolean {
  return word.timingSource !== undefined && UNCERTAIN_SOURCES.has(word.timingSource);
}

export function summarizeTimingQuality(words: readonly TranscriptWord[]): TimingQualitySummary {
  const sourceCounts: TimingQualitySummary["sourceCounts"] = {};
  const uncertainSpans: TimingQualitySpan[] = [];
  let uncertainWords = 0;
  let current: TimingQualitySpan | null = null;

  for (const word of words) {
    const source = word.timingSource ?? "legacy";
    sourceCounts[source] = (sourceCounts[source] ?? 0) + 1;
    if (!isUncertainTiming(word)) {
      current = null;
      continue;
    }
    uncertainWords++;
    if (current && word.startSec - current.endSec <= 0.35) {
      current.endSec = Math.max(current.endSec, word.endSec);
      current.text += word.text;
      current.wordCount++;
    } else {
      current = {
        startSec: word.startSec,
        endSec: word.endSec,
        text: word.text,
        wordCount: 1,
      };
      uncertainSpans.push(current);
    }
  }

  return { totalWords: words.length, uncertainWords, sourceCounts, uncertainSpans };
}

export function wordsForClip(
  words: TranscriptWord[],
  clip: { startSec: number; endSec: number; pieces?: ClipPiece[] }
): TranscriptWord[] {
  if (clip.pieces && clip.pieces.length > 1) return wordsInPieces(words, clip.pieces);
  return words.filter((word) => {
    const mid = (word.startSec + word.endSec) / 2;
    return mid >= clip.startSec && mid <= clip.endSec;
  });
}
