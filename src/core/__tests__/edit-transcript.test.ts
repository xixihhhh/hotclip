import { describe, it, expect } from "vitest";
import { tokenizeForWords, rebuildWords, editSegmentText } from "../../shared/edit-transcript";
import type { Transcript } from "../../shared/api-types";

describe("tokenizeForWords", () => {
  it("CJK 逐字,latin 按词,标点附着前词", () => {
    expect(tokenizeForWords("你好世界")).toEqual(["你", "好", "世", "界"]);
    expect(tokenizeForWords("hello world")).toEqual(["hello", "world"]);
    expect(tokenizeForWords("对,就是 GPT-5 啊!")).toEqual(["对,", "就", "是", "GPT-5", "啊!"]);
  });

  it("空串/纯空白返回空;开头标点独立成词后续附着", () => {
    expect(tokenizeForWords("   ")).toEqual([]);
    expect(tokenizeForWords("——转折")).toEqual(["——", "转", "折"]);
  });
});

describe("rebuildWords", () => {
  it("时间无缝铺满区间,首尾精确对齐", () => {
    const words = rebuildWords("你好word", 10, 14);
    expect(words[0].startSec).toBe(10);
    expect(words[words.length - 1].endSec).toBe(14);
    for (let i = 1; i < words.length; i++) {
      expect(words[i].startSec).toBeCloseTo(words[i - 1].endSec, 10);
    }
  });

  it("CJK 字比 latin 字符占更多时长(视觉宽度权重)", () => {
    const words = rebuildWords("好ok", 0, 3); // 好=2,ok=2 → 各 1.5s
    expect(words[0].endSec).toBeCloseTo(1.5, 5);
  });

  it("空文本/零时长返回空", () => {
    expect(rebuildWords("", 0, 5)).toEqual([]);
    expect(rebuildWords("字", 5, 5)).toEqual([]);
  });
});

describe("editSegmentText", () => {
  const t: Transcript = {
    language: "zh", engine: "x", durationSec: 20,
    segments: [
      { id: 1, startSec: 0, endSec: 4, text: "错误的橘子", words: [{ text: "错", startSec: 0, endSec: 4 }] },
      { id: 2, startSec: 5, endSec: 9, text: "第二句", words: [] },
    ],
  };

  it("替换文本并重建该句词轴,其余句原样,原对象不变", () => {
    const next = editSegmentText(t, 1, "正确的句子");
    expect(next.segments[0].text).toBe("正确的句子");
    expect(next.segments[0].words.length).toBe(5);
    expect(next.segments[0].words[0].startSec).toBe(0);
    expect(next.segments[0].words[4].endSec).toBe(4);
    expect(next.segments[1]).toBe(t.segments[1]);
    expect(t.segments[0].text).toBe("错误的橘子"); // 不可变
  });

  it("空文本视为误操作,原样返回", () => {
    expect(editSegmentText(t, 1, "   ")).toBe(t);
  });
});
