import { describe, expect, it } from "vitest";
import {
  characterErrorRate,
  evaluateQualityFixture,
  highlightRecallAtK,
  timingErrorSummary,
  wordErrorRate,
} from "../quality-eval";

describe("quality evaluation", () => {
  it("computes deterministic multilingual text error rates", () => {
    expect(characterErrorRate("你好世界", "你好世间")).toBeCloseTo(0.25);
    expect(wordErrorRate("hello brave world", "hello world")).toBeCloseTo(1 / 3);
  });

  it("aligns repeated word labels before measuring timing error", () => {
    const summary = timingErrorSummary(
      [{ text: "a", startSec: 0, endSec: 0.4 }, { text: "b", startSec: 0.4, endSec: 0.8 }],
      [{ text: "x", startSec: 0, endSec: 0.2 }, { text: "a", startSec: 0.05, endSec: 0.45 }, { text: "b", startSec: 0.45, endSec: 0.85 }]
    );
    expect(summary.matchedWords).toBe(2);
    expect(summary.medianMs).toBeCloseTo(50);
    expect(summary.p95Ms).toBeCloseTo(50);
  });

  it("measures top-k highlight recall by temporal IoU", () => {
    const testCase = {
      id: "h1",
      expectedRanges: [{ startSec: 10, endSec: 20 }],
      candidates: [
        { startSec: 30, endSec: 40, score: 90 },
        { startSec: 9, endSec: 21, score: 80 },
      ],
    };
    expect(highlightRecallAtK(testCase, 1)).toBe(0);
    expect(highlightRecallAtK(testCase, 2)).toBe(1);
  });

  it("aggregates an empty fixture without NaN", () => {
    const report = evaluateQualityFixture({});
    expect(report.transcript.meanCer).toBeNull();
    expect(report.highlights.recallAt3).toBeNull();
  });
});
