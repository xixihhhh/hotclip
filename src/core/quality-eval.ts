import type { TranscriptWord } from "../shared/api-types";

export interface TextEvalCase {
  id: string;
  referenceText: string;
  actualText: string;
  referenceWords?: TranscriptWord[];
  actualWords?: TranscriptWord[];
}

export interface HighlightEvalCase {
  id: string;
  expectedRanges: Array<{ startSec: number; endSec: number }>;
  candidates: Array<{ startSec: number; endSec: number; score: number }>;
}

export interface QualityEvalFixture {
  transcriptCases?: TextEvalCase[];
  highlightCases?: HighlightEvalCase[];
}

export interface TimingErrorSummary {
  matchedWords: number;
  medianMs: number | null;
  p95Ms: number | null;
}

export interface QualityEvalReport {
  transcript: {
    cases: number;
    meanCer: number | null;
    meanWer: number | null;
    timing: TimingErrorSummary;
  };
  highlights: {
    cases: number;
    recallAt3: number | null;
    recallAt5: number | null;
  };
}

export function editDistance<T>(reference: readonly T[], actual: readonly T[]): number {
  const previous = Array.from({ length: actual.length + 1 }, (_, index) => index);
  const current = new Array<number>(actual.length + 1);
  for (let i = 1; i <= reference.length; i++) {
    current[0] = i;
    for (let j = 1; j <= actual.length; j++) {
      current[j] = reference[i - 1] === actual[j - 1]
        ? previous[j - 1]
        : Math.min(previous[j - 1], previous[j], current[j - 1]) + 1;
    }
    for (let j = 0; j <= actual.length; j++) previous[j] = current[j];
  }
  return previous[actual.length];
}

function normalizedChars(text: string): string[] {
  return Array.from(text.normalize("NFKC").toLowerCase().replace(/\s+/g, ""));
}

function normalizedWords(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}]+/gu) ?? [];
}

function errorRate(reference: readonly string[], actual: readonly string[]): number {
  if (reference.length === 0) return actual.length === 0 ? 0 : 1;
  return editDistance(reference, actual) / reference.length;
}

export function characterErrorRate(reference: string, actual: string): number {
  return errorRate(normalizedChars(reference), normalizedChars(actual));
}

export function wordErrorRate(reference: string, actual: string): number {
  return errorRate(normalizedWords(reference), normalizedWords(actual));
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(fraction * sorted.length) - 1];
}

function timingErrorsMs(reference: TranscriptWord[], actual: TranscriptWord[]): number[] {
  const refTokens = reference.map((word) => normalizedWords(word.text).join(""));
  const actualTokens = actual.map((word) => normalizedWords(word.text).join(""));
  const rows = refTokens.length + 1;
  const cols = actualTokens.length + 1;
  const dp = new Uint16Array(rows * cols);
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      dp[i * cols + j] = refTokens[i - 1] !== "" && refTokens[i - 1] === actualTokens[j - 1]
        ? dp[(i - 1) * cols + j - 1] + 1
        : Math.max(dp[(i - 1) * cols + j], dp[i * cols + j - 1]);
    }
  }
  const errorsMs: number[] = [];
  let i = refTokens.length;
  let j = actualTokens.length;
  while (i > 0 && j > 0) {
    if (refTokens[i - 1] !== "" && refTokens[i - 1] === actualTokens[j - 1] && dp[i * cols + j] === dp[(i - 1) * cols + j - 1] + 1) {
      errorsMs.push(Math.abs(reference[i - 1].startSec - actual[j - 1].startSec) * 1000);
      errorsMs.push(Math.abs(reference[i - 1].endSec - actual[j - 1].endSec) * 1000);
      i--;
      j--;
    } else if (dp[(i - 1) * cols + j] >= dp[i * cols + j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return errorsMs;
}

export function timingErrorSummary(reference: TranscriptWord[], actual: TranscriptWord[]): TimingErrorSummary {
  const errorsMs = timingErrorsMs(reference, actual);
  return { matchedWords: errorsMs.length / 2, medianMs: percentile(errorsMs, 0.5), p95Ms: percentile(errorsMs, 0.95) };
}

function rangeIou(a: { startSec: number; endSec: number }, b: { startSec: number; endSec: number }): number {
  const overlap = Math.max(0, Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec));
  const union = Math.max(a.endSec, b.endSec) - Math.min(a.startSec, b.startSec);
  return union > 0 ? overlap / union : 0;
}

export function highlightRecallAtK(testCase: HighlightEvalCase, k: number, minIou = 0.3): number {
  if (testCase.expectedRanges.length === 0) return 1;
  const top = [...testCase.candidates].sort((a, b) => b.score - a.score).slice(0, k);
  const matched = testCase.expectedRanges.filter((expected) => top.some((candidate) => rangeIou(expected, candidate) >= minIou));
  return matched.length / testCase.expectedRanges.length;
}

function mean(values: number[]): number | null {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function evaluateQualityFixture(fixture: QualityEvalFixture): QualityEvalReport {
  const transcriptCases = fixture.transcriptCases ?? [];
  const highlightCases = fixture.highlightCases ?? [];
  const timingCases = transcriptCases.filter((testCase) => testCase.referenceWords && testCase.actualWords);
  const allTimingErrors = timingCases.flatMap((testCase) => timingErrorsMs(testCase.referenceWords!, testCase.actualWords!));
  return {
    transcript: {
      cases: transcriptCases.length,
      meanCer: mean(transcriptCases.map((testCase) => characterErrorRate(testCase.referenceText, testCase.actualText))),
      meanWer: mean(transcriptCases.map((testCase) => wordErrorRate(testCase.referenceText, testCase.actualText))),
      timing: {
        matchedWords: allTimingErrors.length / 2,
        medianMs: percentile(allTimingErrors, 0.5),
        p95Ms: percentile(allTimingErrors, 0.95),
      },
    },
    highlights: {
      cases: highlightCases.length,
      recallAt3: mean(highlightCases.map((testCase) => highlightRecallAtK(testCase, 3))),
      recallAt5: mean(highlightCases.map((testCase) => highlightRecallAtK(testCase, 5))),
    },
  };
}
