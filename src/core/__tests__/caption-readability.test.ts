import { describe, expect, it } from "vitest";
import { buildCaptionAss, captionReadableChars, captionReadingCps, planReadableCaptions, VERTICAL_LAYOUT } from "../subtitle";
import { buildOverlayPayload } from "../caption-overlay/payload";
import { srtLinesFromWords } from "../srt";
import { lintSubtitleTimeline } from "../subtitle-quality";

describe("language-aware caption display", () => {
  it("uses graphemes and script-specific reading defaults", () => {
    expect(captionReadableChars("cafe\u0301")).toBe(4);
    expect(captionReadingCps("你好")).toBe(9);
    expect(captionReadingCps("こんにちは")).toBe(7);
    expect(captionReadingCps("안녕")).toBe(12);
    expect(captionReadingCps("hello")).toBe(20);
  });
  it("extends short display only into available space; original word timings stay unchanged", () => {
    const words = [{ text: "你好", startSec: 0, endSec: 0.2, timingSource: "native" as const }];
    const before = JSON.stringify(words);
    const plan = planReadableCaptions(words, 22, [], 0.9);
    expect(plan[0].endSec).toBeCloseTo(0.7);
    expect(JSON.stringify(words)).toBe(before);
    expect(planReadableCaptions(words, 22, [0.4], 0.9)[0].endSec).toBe(0.4);
    expect(planReadableCaptions(words, 22, [], 0.3)[0].endSec).toBe(0.3);
  });
  it("merges readable short lines but respects splices and speaker changes", () => {
    const words = [{ text: "好！", startSec: 0, endSec: 0.2, speaker: 0 }, { text: "走吧。", startSec: 0.25, endSec: 0.6, speaker: 0 }];
    expect(planReadableCaptions(words, 22, [], 1)).toHaveLength(1);
    expect(planReadableCaptions(words, 22, [0.23], 1)).toHaveLength(2);
    expect(planReadableCaptions([words[0], { ...words[1], speaker: 1 }], 22, [], 1)).toHaveLength(2);
  });
  it("ASS, overlay, SRT and quality checks share the effective display duration", () => {
    const words = [{ text: "Hello", startSec: 0, endSec: 0.1, timingSource: "native" as const }];
    const options = { readability: true, endSec: 1 };
    const ass = buildCaptionAss(words, 0, VERTICAL_LAYOUT, "karaoke", options);
    expect(ass).toContain("0:00:00.70");
    expect(ass).toContain("\\k10");
    expect(buildOverlayPayload(words, VERTICAL_LAYOUT, options).lines[0].endMs).toBe(700);
    expect(srtLinesFromWords(words, [], [], options)[0].endSec).toBeCloseTo(0.7);
    expect(lintSubtitleTimeline(words, VERTICAL_LAYOUT, "karaoke", [], [], options).status).toBe("pass");
  });
});
