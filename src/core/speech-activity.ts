/**
 * Local speech-activity evidence for safer clip boundaries and jump cuts.
 * The native runner is deliberately thin; trust/refinement lives in pure
 * functions so questionable evidence always falls back to existing behavior.
 */
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { resolveFfmpegPath } from "./binaries";
import {
  ensureModel,
  extractPcmF32le16k,
  modelDir,
  readF32leSamples,
  SILERO_VAD_MODEL,
} from "./models";
import { toAnsiSafeDir } from "./win-ansi-path";
import type { TranscriptWord } from "../shared/api-types";

const SAMPLE_RATE = 16_000;
const WINDOW_SIZE = 512;
const MAX_ANALYSIS_SEC = 180;
const MAX_EDGE_MOVE_SEC = 0.6;
const EDGE_GUARD_SEC = 0.06;
const START_PAD_SEC = 0.08;
const END_PAD_SEC = 0.12;
const MIN_WORD_COVERAGE = 0.45;

/* eslint-disable @typescript-eslint/no-explicit-any */
let sherpa: any = null;
function loadSherpa(): any {
  if (!sherpa) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sherpa = require("sherpa-onnx-node");
  }
  return sherpa;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface SpeechActivitySpan {
  /** Absolute source time. */
  startSec: number;
  endSec: number;
}

export interface SpeechActivityAssessment {
  usable: boolean;
  /** Fraction of transcript-word duration overlapped by detected speech. */
  wordCoverage: number;
}

export interface SpeechBoundaryRefinement {
  startSec: number;
  endSec: number;
  startDeltaSec: number;
  endDeltaSec: number;
  /** VAD speech edges that protect later shot snapping. */
  anchorStartSec?: number;
  anchorEndSec?: number;
}

function overlapSec(a: SpeechActivitySpan, b: SpeechActivitySpan): number {
  return Math.max(0, Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec));
}

/** Sort, clamp and merge detector segments into a stable absolute timeline. */
export function normalizeSpeechSpans(
  spans: SpeechActivitySpan[],
  fromSec = 0,
  toSec = Number.POSITIVE_INFINITY,
  mergeGapSec = 0.08
): SpeechActivitySpan[] {
  const sorted = spans
    .filter((span) => Number.isFinite(span.startSec) && Number.isFinite(span.endSec) && span.endSec > span.startSec)
    .map((span) => ({ startSec: Math.max(fromSec, span.startSec), endSec: Math.min(toSec, span.endSec) }))
    .filter((span) => span.endSec > span.startSec)
    .sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
  const out: SpeechActivitySpan[] = [];
  for (const span of sorted) {
    const previous = out[out.length - 1];
    if (previous && span.startSec <= previous.endSec + mergeGapSec) previous.endSec = Math.max(previous.endSec, span.endSec);
    else out.push({ ...span });
  }
  return out;
}

/** Reject a VAD track that does not corroborate the ASR timeline. */
export function assessSpeechActivity(
  spans: SpeechActivitySpan[],
  words: Array<Pick<TranscriptWord, "startSec" | "endSec">>
): SpeechActivityAssessment {
  const validWords = words.filter((word) => word.endSec > word.startSec);
  const totalWordSec = validWords.reduce((sum, word) => sum + (word.endSec - word.startSec), 0);
  if (spans.length === 0 || totalWordSec <= 0) return { usable: false, wordCoverage: 0 };
  const covered = validWords.reduce((sum, word) => {
    const wordSpan = { startSec: word.startSec, endSec: word.endSec };
    return sum + Math.min(word.endSec - word.startSec, spans.reduce((acc, span) => acc + overlapSec(span, wordSpan), 0));
  }, 0);
  const wordCoverage = Math.max(0, Math.min(1, covered / totalWordSec));
  return { usable: wordCoverage >= MIN_WORD_COVERAGE, wordCoverage };
}

/** True when meaningful detected speech intersects a proposed removal span. */
export function hasSpeechInRange(
  spans: SpeechActivitySpan[],
  fromSec: number,
  toSec: number,
  minOverlapSec = 0.02
): boolean {
  if (!(toSec > fromSec)) return false;
  const range = { startSec: fromSec, endSec: toSec };
  return spans.some((span) => overlapSec(span, range) >= minOverlapSec);
}

function anchorSpan(
  spans: SpeechActivitySpan[],
  word: Pick<TranscriptWord, "startSec" | "endSec">
): SpeechActivitySpan | undefined {
  const duration = Math.max(0, word.endSec - word.startSec);
  const required = Math.min(0.08, Math.max(0.02, duration * 0.15));
  return spans
    .map((span) => ({ span, overlap: overlapSec(span, word) }))
    .filter((item) => item.overlap >= required)
    .sort((a, b) => b.overlap - a.overlap)[0]?.span;
}

/** VAD spans directly corroborating the first and last transcript words. */
export function speechAnchorBounds(
  spans: SpeechActivitySpan[],
  words: Array<Pick<TranscriptWord, "startSec" | "endSec">>
): { startSec?: number; endSec?: number } {
  if (words.length === 0) return {};
  const first = anchorSpan(spans, words[0]);
  const last = anchorSpan(spans, words[words.length - 1]);
  return {
    ...(first ? { startSec: first.startSec } : {}),
    ...(last ? { endSec: last.endSec } : {}),
  };
}

function clamp(value: number, lower: number, upper: number): number {
  return Math.min(upper, Math.max(lower, value));
}

/**
 * Refine automatic outer bounds only when a VAD span directly overlaps the
 * first/last word. Movement is capped, never crosses adjacent words, and can
 * trim only silence that remains outside the anchor word.
 */
export function refineSpeechBoundaries(
  startSec: number,
  endSec: number,
  words: Array<Pick<TranscriptWord, "startSec" | "endSec">>,
  spans: SpeechActivitySpan[],
  context: { prevWordEndSec?: number | null; nextWordStartSec?: number | null } = {}
): SpeechBoundaryRefinement {
  const noChange: SpeechBoundaryRefinement = { startSec, endSec, startDeltaSec: 0, endDeltaSec: 0 };
  if (!(endSec > startSec) || words.length === 0 || !assessSpeechActivity(spans, words).usable) return noChange;
  const firstWord = words[0];
  const lastWord = words[words.length - 1];
  const anchors = speechAnchorBounds(spans, words);
  let refinedStart = startSec;
  let refinedEnd = endSec;

  if (anchors.startSec !== undefined) {
    const lower = Math.max(0, startSec - MAX_EDGE_MOVE_SEC, (context.prevWordEndSec ?? -Infinity) + EDGE_GUARD_SEC);
    const upper = Math.min(startSec + MAX_EDGE_MOVE_SEC, firstWord.startSec - EDGE_GUARD_SEC);
    if (upper >= lower) refinedStart = clamp(Math.min(anchors.startSec - START_PAD_SEC, upper), lower, upper);
  }
  if (anchors.endSec !== undefined) {
    const lower = Math.max(startSec + 0.1, endSec - MAX_EDGE_MOVE_SEC, lastWord.endSec + EDGE_GUARD_SEC);
    const upper = Math.min(endSec + MAX_EDGE_MOVE_SEC, (context.nextWordStartSec ?? Infinity) - EDGE_GUARD_SEC);
    if (upper >= lower) refinedEnd = clamp(Math.max(anchors.endSec + END_PAD_SEC, lower), lower, upper);
  }
  if (refinedEnd - refinedStart < 0.5) return noChange;
  if (Math.abs(refinedStart - startSec) < 0.025) refinedStart = startSec;
  if (Math.abs(refinedEnd - endSec) < 0.025) refinedEnd = endSec;
  return {
    startSec: refinedStart,
    endSec: refinedEnd,
    startDeltaSec: refinedStart - startSec,
    endDeltaSec: refinedEnd - endSec,
    ...(anchors.startSec !== undefined ? { anchorStartSec: anchors.startSec } : {}),
    ...(anchors.endSec !== undefined ? { anchorEndSec: anchors.endSec } : {}),
  };
}

export function speechActivityRangeSupported(startSec: number, endSec: number): boolean {
  return Number.isFinite(startSec) && Number.isFinite(endSec) && endSec > startSec && endSec - startSec <= MAX_ANALYSIS_SEC;
}

/** Detect absolute speech spans inside one bounded source range. */
export async function detectSpeechActivity(
  filePath: string,
  startSec: number,
  endSec: number,
  modelsRoot: string,
  signal?: AbortSignal,
  audioStreamIndex?: number
): Promise<SpeechActivitySpan[]> {
  if (!speechActivityRangeSupported(startSec, endSec)) throw new Error("speech activity range is unsupported");
  signal?.throwIfAborted();
  const base = Math.max(0, startSec);
  const durationSec = endSec - base;
  await ensureModel(modelsRoot, SILERO_VAD_MODEL, undefined, signal);
  const modelRoot = await toAnsiSafeDir(modelDir(modelsRoot, SILERO_VAD_MODEL));
  const workDir = await mkdtemp(join(tmpdir(), "hotclip-vad-"));
  try {
    const pcmPath = join(workDir, "audio.f32le");
    await extractPcmF32le16k(
      resolveFfmpegPath(),
      filePath,
      pcmPath,
      { startSec: base, durationSec },
      audioStreamIndex,
      signal
    );
    const samples = await readF32leSamples(pcmPath);
    signal?.throwIfAborted();
    const { Vad } = loadSherpa();
    const vad = new Vad(
      {
        sileroVad: {
          model: join(modelRoot, SILERO_VAD_MODEL.singleFile!),
          threshold: 0.5,
          minSilenceDuration: 0.32,
          minSpeechDuration: 0.16,
          windowSize: WINDOW_SIZE,
          maxSpeechDuration: 30,
        },
        sampleRate: SAMPLE_RATE,
        numThreads: 1,
        provider: "cpu",
        debug: false,
      },
      Math.min(60, Math.max(10, Math.ceil(durationSec)))
    );
    const spans: SpeechActivitySpan[] = [];
    const drain = (): void => {
      while (!vad.isEmpty()) {
        const segment = vad.front() as { start: number; samples: Float32Array };
        spans.push({
          startSec: base + segment.start / SAMPLE_RATE,
          endSec: base + (segment.start + segment.samples.length) / SAMPLE_RATE,
        });
        vad.pop();
      }
    };
    for (let offset = 0; offset < samples.length; offset += WINDOW_SIZE) {
      signal?.throwIfAborted();
      const available = Math.min(WINDOW_SIZE, samples.length - offset);
      if (available === WINDOW_SIZE) vad.acceptWaveform(samples.subarray(offset, offset + WINDOW_SIZE));
      else {
        const finalWindow = new Float32Array(WINDOW_SIZE);
        finalWindow.set(samples.subarray(offset));
        vad.acceptWaveform(finalWindow);
      }
      drain();
    }
    vad.flush();
    drain();
    return normalizeSpeechSpans(spans, base, endSec);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
