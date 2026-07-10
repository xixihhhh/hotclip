import { describe, it, expect } from "vitest";
import { formatSrtTime, srtLinesFromWords, buildSrt, SRT_MAX_LINE_UNITS } from "../srt";
import type { TranscriptWord } from "../../shared/api-types";

const w = (text: string, startSec: number, endSec: number): TranscriptWord => ({ text, startSec, endSec });

describe("formatSrtTime", () => {
  it("HH:MM:SS,mmm 格式与毫秒进位", () => {
    expect(formatSrtTime(0)).toBe("00:00:00,000");
    expect(formatSrtTime(65.4321)).toBe("00:01:05,432");
    expect(formatSrtTime(3661.5)).toBe("01:01:01,500");
    expect(formatSrtTime(1.9996)).toBe("00:00:02,000"); // 四舍五入进位
  });

  it("负数夹为 0", () => {
    expect(formatSrtTime(-3)).toBe("00:00:00,000");
  });
});

describe("srtLinesFromWords", () => {
  it("按断行规则分行,行尾 hold 到下一行开头(封顶)", () => {
    const words = [
      ...Array.from({ length: 10 }, (_, i) => w("字字字字", i, i + 0.9)), // 每词 8 单位 → 4 词一行(36 上限)
    ];
    const lines = srtLinesFromWords(words);
    expect(lines.length).toBeGreaterThan(1);
    // 行间无重叠:上一行 end ≤ 下一行 start
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i - 1].endSec).toBeLessThanOrEqual(lines[i].startSec + 1e-9);
    }
    // 最后一行以末词结束
    expect(lines[lines.length - 1].endSec).toBeCloseTo(9.9);
  });

  it("英文词间加空格,CJK 交界不加(与烧录字幕同规则)", () => {
    const lines = srtLinesFromWords([w("hello", 0, 0.5), w("world", 0.5, 1), w("你好", 1, 1.5)]);
    expect(lines[0].text).toBe("hello world你好");
  });

  it("译文按最大时间重叠附为第二行", () => {
    const words = [w("你好", 0, 1), w("世界", 1, 2), w("再见", 30, 31)];
    const lines = srtLinesFromWords(words, [30], [
      { startSec: 0, endSec: 2, text: "Hello world" },
      { startSec: 30, endSec: 31, text: "Goodbye" },
    ]);
    expect(lines[0].secondary).toBe("Hello world");
    expect(lines[lines.length - 1].secondary).toBe("Goodbye");
  });

  it("空词返回空数组", () => {
    expect(srtLinesFromWords([])).toEqual([]);
  });
});

describe("buildSrt", () => {
  it("序号/时间行/正文/空行结构,双语两行", () => {
    const srt = buildSrt([
      { startSec: 0, endSec: 1.5, text: "你好世界", secondary: "Hello world" },
      { startSec: 2, endSec: 3, text: "第二条" },
    ]);
    expect(srt).toBe(
      "1\n00:00:00,000 --> 00:00:01,500\n你好世界\nHello world\n\n2\n00:00:02,000 --> 00:00:03,000\n第二条\n"
    );
  });
});

describe("行宽常量", () => {
  it("SRT 行宽比竖屏字幕宽(通用播放器习惯)", () => {
    expect(SRT_MAX_LINE_UNITS).toBeGreaterThan(22);
  });
});
