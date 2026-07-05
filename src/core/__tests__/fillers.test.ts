import { describe, expect, it } from "vitest";
import { findFillerWords, dropFillerWords, fillerCutSpans } from "../fillers";
import { computeJumpCut, subtractSpans } from "../gaps";
import type { TranscriptWord } from "../../shared/api-types";

const w = (text: string, s: number, e: number): TranscriptWord => ({ text, startSec: s, endSec: e });

describe("findFillerWords", () => {
  it("flags hesitation tokens, tolerating attached punctuation", () => {
    const words = [w("嗯,", 0, 0.2), w("这个", 0.3, 0.6), w("产品", 0.6, 1.0), w("呃", 1.2, 1.4), w("很好", 1.5, 2.0)];
    const hits = findFillerWords(words);
    expect(hits.map((h) => h.index)).toEqual([0, 3]);
    expect(hits[0].kind).toBe("filler");
  });

  it("keeps real words that merely resemble fillers in context", () => {
    const words = [w("然后", 0, 0.3), w("那个", 0.4, 0.7), w("啊", 0.8, 1.0)];
    expect(findFillerWords(words)).toEqual([]);
  });

  it("flags the first of an immediate stutter repeat, not slow deliberate repeats", () => {
    const stutter = [w("这个", 0, 0.3), w("这个", 0.35, 0.65), w("很好", 0.7, 1.0)];
    const hits = findFillerWords(stutter);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ index: 0, kind: "stutter" });
    // a 1s pause between repeats reads as emphasis — leave it alone
    const deliberate = [w("很好", 0, 0.3), w("很好", 1.5, 1.8)];
    expect(findFillerWords(deliberate)).toEqual([]);
  });
});

describe("dropFillerWords / fillerCutSpans", () => {
  it("removes flagged words and merges adjacent spans", () => {
    const words = [w("嗯", 0, 0.2), w("呃", 0.25, 0.4), w("好", 0.6, 1.0)];
    const hits = findFillerWords(words);
    expect(dropFillerWords(words, hits).map((x) => x.text)).toEqual(["好"]);
    const spans = fillerCutSpans(hits);
    expect(spans).toEqual([{ startSec: 0, endSec: 0.4 }]);
  });
});

describe("subtractSpans", () => {
  it("splits kept segments around forced cuts and drops slivers", () => {
    const out = subtractSpans(
      [{ startSec: 0, endSec: 10 }],
      [{ startSec: 2, endSec: 2.5 }, { startSec: 9.95, endSec: 10 }]
    );
    expect(out).toEqual([
      { startSec: 0, endSec: 2 },
      { startSec: 2.5, endSec: 9.95 },
    ]);
  });
});

describe("computeJumpCut with forced filler cuts", () => {
  it("cuts an audible filler that gap logic and the silence gate would keep", () => {
    // 嗯 at 1.0-1.3s sits between words with small gaps — no gap cut possible
    const words = [w("前面", 0.2, 0.9), w("后面", 1.5, 2.2)];
    const plan = computeJumpCut(words, 0, 2.5, {
      forceCutSpans: [{ startSec: 1.0, endSec: 1.3 }],
      gapThresholdSec: Infinity,
    });
    expect(plan.segments).toHaveLength(2);
    expect(plan.segments[0].endSec).toBeCloseTo(1.0, 5);
    expect(plan.segments[1].startSec).toBeCloseTo(1.3, 5);
    // splice point becomes a caption forced break
    expect(plan.breaks).toHaveLength(1);
  });

  it("short-cut smoothing must not fill a forced cut back in", () => {
    const words = [w("前面", 0.2, 0.9), w("后面", 1.2, 2.0)];
    const plan = computeJumpCut(words, 0, 2.5, {
      forceCutSpans: [{ startSec: 0.95, endSec: 1.1 }], // 0.15s < MIN_CUT_SEC
      gapThresholdSec: Infinity,
    });
    expect(plan.segments).toHaveLength(2);
    expect(plan.removedSec).toBeGreaterThan(0.1);
  });
});