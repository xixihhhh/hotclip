import { describe, expect, it } from "vitest";
import { buildOverlayPayload } from "../caption-overlay/payload";
import { VERTICAL_LAYOUT } from "../subtitle";
import type { TranscriptWord } from "../../shared/api-types";

const w = (text: string, s: number, e: number): TranscriptWord => ({ text, startSec: s, endSec: e });

describe("buildOverlayPayload", () => {
  const words = [w("你看", 0, 0.4), w("这个", 0.4, 0.8), w("速度", 0.8, 1.2), w("真的", 3.0, 3.4), w("绝了", 3.4, 3.8)];

  it("derives geometry from the ASS layout", () => {
    const p = buildOverlayPayload(words, VERTICAL_LAYOUT);
    expect(p.width).toBe(1080);
    expect(p.height).toBe(1920);
    expect(p.fontSize).toBe(78);
    // marginV 560 from the bottom of 1920 → baseline ≈ 70.8%
    expect(p.baselineFrac).toBeCloseTo((1920 - 560) / 1920, 5);
  });

  it("times words in ms and lingers the last line", () => {
    const p = buildOverlayPayload(words, VERTICAL_LAYOUT);
    const last = p.lines[p.lines.length - 1];
    expect(last.words[last.words.length - 1].endMs).toBe(3800);
    expect(last.endMs).toBe(3800 + 350);
  });

  it("marks keyword words after fusion", () => {
    const kw = buildOverlayPayload(words, VERTICAL_LAYOUT, { keywords: ["速度"] });
    const flat = kw.lines.flatMap((l) => l.words);
    expect(flat.find((x) => x.text === "速度")?.keyword).toBe(true);
    expect(flat.find((x) => x.text === "你看")?.keyword).toBe(false);
  });

  it("respects forced breaks (jump-cut splice points)", () => {
    const tight = [w("一", 0, 0.3), w("二", 0.3, 0.6), w("三", 0.6, 0.9)];
    const p = buildOverlayPayload(tight, VERTICAL_LAYOUT, { forcedBreaks: [0.6] });
    expect(p.lines.length).toBe(2);
    expect(p.lines[1].words[0].text).toBe("三");
  });

  it("carries per-word speaker ids through for caption coloring", () => {
    const spoken = [
      { ...w("甲", 0, 0.4), speaker: 0 },
      { ...w("乙", 0.4, 0.8), speaker: 1 },
    ];
    const p = buildOverlayPayload(spoken, VERTICAL_LAYOUT);
    const flat = p.lines.flatMap((l) => l.words);
    expect(flat.find((x) => x.text === "甲")?.speaker).toBe(0);
    expect(flat.find((x) => x.text === "乙")?.speaker).toBe(1);
  });
});
