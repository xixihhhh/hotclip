import { describe, it, expect } from "vitest";
import { sanitizeFilename, clipFilename, summarizeEdit } from "../export";

describe("summarizeEdit", () => {
  const plan = (durationSec: number, segs: number) => ({
    segments: Array.from({ length: segs }, () => ({})),
    durationSec,
  });

  it("reports splices, kept/removed seconds, and cut ratio", () => {
    // 4s clip cut down to 2.1s across 2 kept segments → 1.9s removed, 47.5%
    expect(summarizeEdit(4, plan(2.1, 2))).toEqual({
      splices: 2,
      keptSec: 2.1,
      removedSec: 1.9,
      cutRatio: 0.475,
    });
  });

  it("is null when nothing was spliced", () => {
    expect(summarizeEdit(4, null)).toBeNull();
    expect(summarizeEdit(0, plan(2, 1))).toBeNull(); // guard against divide-by-zero
  });

  it("never reports negative removal when the plan kept more than the span", () => {
    const out = summarizeEdit(2, plan(2.05, 1)); // rounding slack
    expect(out?.removedSec).toBe(0);
    expect(out?.cutRatio).toBe(0);
  });
});

describe("sanitizeFilename", () => {
  it("keeps CJK/latin/digits/space/dash, strips hostile chars", () => {
    expect(sanitizeFilename('半杯水都不渗?实测/给你看:第1集')).toBe("半杯水都不渗实测给你看第1集");
    expect(sanitizeFilename('a<b>c:"d/e\\f|g?h*i')).toBe("abcdefghi");
    expect(sanitizeFilename("Hello World - Ep 2")).toBe("Hello World - Ep 2");
  });

  it("collapses whitespace and trims", () => {
    expect(sanitizeFilename("  a   b  ")).toBe("a b");
  });

  it("caps length at 60 and falls back when empty", () => {
    expect(sanitizeFilename("好".repeat(100))).toHaveLength(60);
    expect(sanitizeFilename("???")).toBe("clip");
    expect(sanitizeFilename("", "video")).toBe("video");
  });
});

describe("clipFilename", () => {
  it("prefixes a zero-padded index", () => {
    expect(clipFilename(1, "爆点标题")).toBe("01-爆点标题.mp4");
    expect(clipFilename(12, "t/i:t*le")).toBe("12-title.mp4");
  });
});
