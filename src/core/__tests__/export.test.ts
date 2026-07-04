import { describe, it, expect } from "vitest";
import { sanitizeFilename, clipFilename } from "../export";

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
