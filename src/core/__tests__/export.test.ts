import { describe, it, expect } from "vitest";
import { sanitizeFilename, clipFilename, summarizeEdit, buildChapters } from "../export";
import { buildConcatList, buildConcatArgs } from "../cut";

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

describe("精华合集 (concat + chapters)", () => {
  it("buildConcatList:一行一个 file,单引号按 concat demuxer 语法转义", () => {
    expect(buildConcatList(["/a/01-x.mp4", "/a/02-y.mp4"])).toBe("file '/a/01-x.mp4'\nfile '/a/02-y.mp4'\n");
    expect(buildConcatList(["/a/it's.mp4"])).toBe("file '/a/it'\\''s.mp4'\n");
  });

  it("buildConcatArgs:流复制 + faststart,不重编码", () => {
    const args = buildConcatArgs("/tmp/l.txt", "/out/合集.mp4");
    expect(args.join(" ")).toContain("-f concat -safe 0 -i /tmp/l.txt");
    expect(args.join(" ")).toContain("-c copy");
    expect(args).toContain("+faststart");
    expect(args.join(" ")).not.toContain("libx264");
  });

  it("buildChapters:0:00 起累计时刻,超一小时带小时位", () => {
    expect(
      buildChapters([
        { title: "开场爆点", durationSec: 32.7 },
        { title: "第二条", durationSec: 41.2 },
        { title: "压轴", durationSec: 3600 },
      ])
    ).toBe("0:00 开场爆点\n0:32 第二条\n1:13 压轴\n");
    expect(buildChapters([{ title: "a", durationSec: 10 }, { title: "b", durationSec: 5 }, { title: "c", durationSec: 1 }]).split("\n")[2]).toBe("0:15 c");
    // 累计超 1 小时后第三条的时刻带小时位
    expect(
      buildChapters([
        { title: "x", durationSec: 3599 },
        { title: "y", durationSec: 2 },
        { title: "z", durationSec: 1 },
      ]).split("\n")[2]
    ).toBe("1:00:01 z");
  });
});
