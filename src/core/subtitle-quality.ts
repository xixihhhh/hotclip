import type {
  SubtitleQualityIssue,
  SubtitleQualityReport,
  TranscriptWord,
} from "../shared/api-types";
import { isUncertainTiming, summarizeTimingQuality } from "../shared/transcript-quality";
import {
  captionMaxLineUnits,
  groupWordsIntoLines,
  mergeKeywordWords,
  widthUnits,
  type AssLayout,
  type CaptionStyle,
} from "./subtitle";

export const SUBTITLE_MAX_CPS = 20;
export const SUBTITLE_MIN_LINE_SEC = 0.45;
const OVERLAP_TOLERANCE_SEC = 0.05;

function readableChars(words: readonly TranscriptWord[]): number {
  return Array.from(words.map((word) => word.text).join("").replace(/\s+/g, "")).length;
}

export function lintSubtitleTimeline(
  words: TranscriptWord[],
  layout: AssLayout,
  style: CaptionStyle,
  forcedBreaks: number[] = [],
  keywords: string[] = []
): SubtitleQualityReport {
  const issues: SubtitleQualityIssue[] = [];
  const maxUnits = captionMaxLineUnits(style, layout);
  const ordered = [...words].sort((a, b) => a.startSec - b.startSec);

  for (const word of ordered) {
    if (!Number.isFinite(word.startSec) || !Number.isFinite(word.endSec) || word.endSec <= word.startSec) {
      issues.push({
        code: "invalid-timing",
        severity: "error",
        startSec: Number.isFinite(word.startSec) ? word.startSec : 0,
        endSec: Number.isFinite(word.endSec) ? word.endSec : 0,
        wordCount: 1,
      });
    }
  }

  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1];
    const word = ordered[index];
    const overlap = previous.endSec - word.startSec;
    if (overlap > OVERLAP_TOLERANCE_SEC) {
      issues.push({
        code: "overlap",
        severity: "error",
        startSec: word.startSec,
        endSec: Math.max(word.endSec, previous.endSec),
        value: Number(overlap.toFixed(3)),
        wordCount: 2,
      });
    }
  }

  const validWords = ordered.filter((word) => Number.isFinite(word.startSec) && Number.isFinite(word.endSec) && word.endSec > word.startSec);
  const displayWords = style === "keyword" || style === "minimal"
    ? mergeKeywordWords(validWords, keywords)
    : validWords;
  for (const word of displayWords) {
    if (widthUnits(word.text) > maxUnits) {
      issues.push({
        code: "oversize-token",
        severity: "warning",
        startSec: word.startSec,
        endSec: word.endSec,
        value: widthUnits(word.text),
        wordCount: 1,
      });
    }
  }
  const lines = groupWordsIntoLines(displayWords, maxUnits, forcedBreaks);
  let maxCps = 0;
  for (const line of lines) {
    const startSec = line[0].startSec;
    const endSec = line[line.length - 1].endSec;
    const durationSec = Math.max(0.001, endSec - startSec);
    const chars = readableChars(line);
    const cps = chars / durationSec;
    maxCps = Math.max(maxCps, cps);
    if (cps > SUBTITLE_MAX_CPS) {
      issues.push({
        code: "reading-speed",
        severity: "warning",
        startSec,
        endSec,
        value: Number(cps.toFixed(1)),
        wordCount: line.length,
      });
    }
    if (chars >= 4 && durationSec < SUBTITLE_MIN_LINE_SEC) {
      issues.push({
        code: "short-display",
        severity: "warning",
        startSec,
        endSec,
        value: Number(durationSec.toFixed(3)),
        wordCount: line.length,
      });
    }
  }

  const timing = summarizeTimingQuality(validWords);
  for (const span of timing.uncertainSpans) {
    issues.push({
      code: "uncertain-timing",
      severity: "warning",
      startSec: span.startSec,
      endSec: span.endSec,
      wordCount: span.wordCount,
    });
  }

  const hasError = issues.some((issue) => issue.severity === "error");
  return {
    status: hasError ? "error" : issues.length > 0 ? "warn" : "pass",
    lineCount: lines.length,
    maxCps: Number(maxCps.toFixed(1)),
    uncertainWords: validWords.filter(isUncertainTiming).length,
    issues,
  };
}
