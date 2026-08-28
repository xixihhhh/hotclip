import { describe, expect, it } from "vitest";
import { summarizeTimingQuality, wordsForClip } from "../transcript-quality";

describe("transcript timing quality", () => {
  const words = [
    { text: "原", startSec: 0, endSec: 0.4, timingSource: "native" as const },
    { text: "估", startSec: 0.4, endSec: 0.8, timingSource: "edited" as const },
    { text: "算", startSec: 0.8, endSec: 1.2, timingSource: "interpolated" as const },
    { text: "旧", startSec: 4, endSec: 4.5 },
  ];

  it("groups adjacent uncertain words and leaves legacy timing neutral", () => {
    const summary = summarizeTimingQuality(words);
    expect(summary.uncertainWords).toBe(2);
    expect(summary.uncertainSpans).toEqual([{ startSec: 0.4, endSec: 1.2, text: "估算", wordCount: 2 }]);
    expect(summary.sourceCounts.legacy).toBe(1);
  });

  it("selects candidate words across disjoint pieces", () => {
    expect(wordsForClip(words, {
      startSec: 0,
      endSec: 5,
      pieces: [{ startSec: 0, endSec: 0.5 }, { startSec: 3.5, endSec: 5 }],
    }).map((word) => word.text)).toEqual(["原", "旧"]);
  });
});
