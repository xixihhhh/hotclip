import { describe, expect, it } from "vitest";
import {
  assessSpeechActivity,
  hasSpeechInRange,
  normalizeSpeechSpans,
  refineSpeechBoundaries,
  speechActivityRangeSupported,
} from "../speech-activity";
import type { TranscriptWord } from "../../shared/api-types";

const word = (startSec: number, endSec: number): TranscriptWord => ({ text: "词", startSec, endSec });

describe("speech activity evidence", () => {
  it("sorts, clamps and merges close detector spans", () => {
    expect(normalizeSpeechSpans([
      { startSec: 2, endSec: 3 },
      { startSec: 0.8, endSec: 1.4 },
      { startSec: 1.45, endSec: 2.1 },
      { startSec: -1, endSec: 0.2 },
    ], 0, 4)).toEqual([
      { startSec: 0, endSec: 0.2 },
      { startSec: 0.8, endSec: 3 },
    ]);
  });

  it("trusts VAD only when it corroborates enough transcript duration", () => {
    const words = [word(1, 2), word(3, 4)];
    expect(assessSpeechActivity([{ startSec: 0.9, endSec: 2.1 }, { startSec: 2.9, endSec: 4.1 }], words))
      .toEqual({ usable: true, wordCoverage: 1 });
    const weak = assessSpeechActivity([{ startSec: 1, endSec: 1.2 }], words);
    expect(weak.usable).toBe(false);
    expect(weak.wordCoverage).toBeCloseTo(0.1, 5);
  });

  it("detects meaningful speech overlap inside a proposed removal", () => {
    const spans = [{ startSec: 5.2, endSec: 5.8 }];
    expect(hasSpeechInRange(spans, 5, 6)).toBe(true);
    expect(hasSpeechInRange(spans, 4, 5.21, 0.02)).toBe(false);
  });

  it("refines automatic edges within caps and exposes anchors for shot guards", () => {
    const words = [word(10.1, 10.5), word(11.5, 11.9)];
    const spans = [{ startSec: 9.92, endSec: 10.55 }, { startSec: 11.45, endSec: 12.08 }];
    const result = refineSpeechBoundaries(10, 12, words, spans);
    expect(result.startSec).toBeCloseTo(9.84, 5);
    expect(result.endSec).toBeCloseTo(12.2, 5);
    expect(result.anchorStartSec).toBe(9.92);
    expect(result.anchorEndSec).toBe(12.08);
  });

  it("never expands across adjacent transcript words", () => {
    const words = [word(10.1, 10.5), word(11.5, 11.9)];
    const spans = [{ startSec: 9.5, endSec: 10.55 }, { startSec: 11.45, endSec: 12.5 }];
    const result = refineSpeechBoundaries(10, 12, words, spans, {
      prevWordEndSec: 9.9,
      nextWordStartSec: 12.15,
    });
    expect(result.startSec).toBeCloseTo(9.96, 5);
    expect(result.endSec).toBeCloseTo(12.09, 5);
  });

  it("keeps exact historical bounds when evidence is implausible", () => {
    const result = refineSpeechBoundaries(10, 12, [word(10.1, 11.9)], [{ startSec: 10.1, endSec: 10.2 }]);
    expect(result).toEqual({ startSec: 10, endSec: 12, startDeltaSec: 0, endDeltaSec: 0 });
  });

  it("bounds native analysis windows", () => {
    expect(speechActivityRangeSupported(0, 180)).toBe(true);
    expect(speechActivityRangeSupported(0, 180.01)).toBe(false);
    expect(speechActivityRangeSupported(3, 3)).toBe(false);
  });
});
