import { describe, it, expect } from "vitest";
import {
  sliceWords,
  groupWordsIntoLines,
  toAssTime,
  buildKaraokeAss,
  VERTICAL_LAYOUT,
  HORIZONTAL_LAYOUT,
} from "../subtitle";
import type { Transcript, TranscriptWord } from "../../shared/api-types";

function w(text: string, startSec: number, endSec: number): TranscriptWord {
  return { text, startSec, endSec };
}

const TRANSCRIPT: Transcript = {
  language: "zh",
  engine: "test",
  durationSec: 30,
  segments: [
    { id: 1, startSec: 0, endSec: 4, text: "你好世界", words: [w("你", 0, 1), w("好", 1, 2), w("世", 2, 3), w("界", 3, 4)] },
    { id: 2, startSec: 5, endSec: 8, text: "第二句话", words: [w("第", 5, 6), w("二", 6, 7), w("句", 7, 7.5), w("话", 7.5, 8)] },
  ],
};

describe("sliceWords", () => {
  it("returns only words whose midpoint falls inside the clip", () => {
    const words = sliceWords(TRANSCRIPT, 1, 6);
    expect(words.map((x) => x.text).join("")).toBe("好世界第");
  });

  it("skips whole segments outside the range", () => {
    expect(sliceWords(TRANSCRIPT, 10, 20)).toEqual([]);
  });
});

describe("groupWordsIntoLines", () => {
  it("breaks on the width cap (CJK counts double)", () => {
    // 6 CJK chars = 12 units; cap 8 → lines of 4 units = 2 chars
    const words = Array.from("一二三四五六").map((ch, i) => w(ch, i, i + 1));
    const lines = groupWordsIntoLines(words, 4);
    expect(lines.map((l) => l.map((x) => x.text).join(""))).toEqual(["一二", "三四", "五六"]);
  });

  it("breaks on silence gaps > 0.8s", () => {
    const words = [w("a", 0, 0.5), w("b", 0.6, 1), w("c", 2.5, 3)];
    const lines = groupWordsIntoLines(words, 100);
    expect(lines).toHaveLength(2);
    expect(lines[1][0].text).toBe("c");
  });
});

describe("toAssTime", () => {
  it("formats H:MM:SS.CC and clamps negatives to zero", () => {
    expect(toAssTime(0)).toBe("0:00:00.00");
    expect(toAssTime(62.345)).toBe("0:01:02.35"); // rounds to centiseconds
    expect(toAssTime(3600 + 61.5)).toBe("1:01:01.50");
    expect(toAssTime(-3)).toBe("0:00:00.00");
  });
});

describe("buildKaraokeAss", () => {
  const words = [w("你", 10, 10.5), w("好", 10.5, 11), w("hello", 11, 11.8), w("world", 12, 12.6)];

  it("emits a vertical PlayRes header and one dialogue per line", () => {
    const ass = buildKaraokeAss(words, 10, VERTICAL_LAYOUT, "PingFang SC");
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("PlayResY: 1920");
    expect(ass).toContain("Style: Karaoke,PingFang SC,");
    expect(ass.match(/^Dialogue:/gm)).toHaveLength(1);
  });

  it("shifts timestamps to clip-relative and sweeps \\k through inter-word gaps", () => {
    const ass = buildKaraokeAss(words, 10, HORIZONTAL_LAYOUT, "Arial");
    // line spans 10..12.6 abs → 0:00:00.00..0:00:02.60 rel
    expect(ass).toContain("Dialogue: 0,0:00:00.00,0:00:02.60,Karaoke");
    // "hello" sweeps until "world" STARTS (12) not until it ends itself (11.8) → 100cs
    expect(ass).toContain("{\\k100}hello ");
    // last word sweeps its own duration → 60cs, and latin↔latin got a space before it
    expect(ass).toContain("{\\k60}world");
  });

  it("joins CJK bare and strips ASS-hostile characters", () => {
    const hostile = [w("你{好}", 0, 1), w("世\\界", 1, 2)];
    const ass = buildKaraokeAss(hostile, 0, HORIZONTAL_LAYOUT, "Arial");
    expect(ass).toContain("{\\k100}你好{\\k100}世界");
  });
});
