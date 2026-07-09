import { describe, it, expect } from "vitest";
import {
  contextWindow,
  wordsInWindow,
  snapToWordEdge,
  clampDrag,
  clipText,
  REVIEW_MIN_SEC,
  REVIEW_MAX_SEC,
} from "../../shared/review";
import type { Transcript } from "../../shared/api-types";

// 构造三句逐字稿:10-13 / 14-17 / 30-33(中间留空档)
function mockTranscript(): Transcript {
  const seg = (id: number, startSec: number, endSec: number, text: string) => ({
    id,
    startSec,
    endSec,
    text,
    words: Array.from(text).map((ch, i) => ({
      text: ch,
      startSec: startSec + ((endSec - startSec) * i) / text.length,
      endSec: startSec + ((endSec - startSec) * (i + 1)) / text.length,
    })),
  });
  return {
    language: "zh",
    engine: "mock",
    durationSec: 100,
    segments: [seg(1, 10, 13, "第一句话"), seg(2, 14, 17, "第二句话"), seg(3, 30, 33, "第三句话")],
  };
}

describe("contextWindow", () => {
  it("切片两侧各留余量,且不越出 [0, duration]", () => {
    const w = contextWindow(10, 20, 100);
    expect(w.winStartSec).toBeCloseTo(4); // pad = max(6, 10*0.4=4) = 6
    expect(w.winEndSec).toBeCloseTo(26);
    expect(contextWindow(2, 8, 100).winStartSec).toBe(0);
    expect(contextWindow(90, 98, 100).winEndSec).toBe(100);
  });

  it("长片的余量按比例放大但封顶 20s", () => {
    const w = contextWindow(100, 200, 1000); // dur=100 → pad = min(20, 40) = 20
    expect(w.winStartSec).toBe(80);
    expect(w.winEndSec).toBe(220);
  });
});

describe("wordsInWindow", () => {
  it("只返回与窗口重叠的词,按时间排序", () => {
    const words = wordsInWindow(mockTranscript(), 12, 15);
    expect(words.length).toBeGreaterThan(0);
    expect(words.every((w) => w.endSec > 12 && w.startSec < 15)).toBe(true);
    for (let i = 1; i < words.length; i++) {
      expect(words[i].startSec).toBeGreaterThanOrEqual(words[i - 1].startSec);
    }
  });

  it("窗口外无词时为空", () => {
    expect(wordsInWindow(mockTranscript(), 50, 60)).toEqual([]);
  });
});

describe("snapToWordEdge", () => {
  const words = [
    { startSec: 10, endSec: 10.5 },
    { startSec: 10.6, endSec: 11.2 },
  ];

  it("容差内吸到最近的词首/词尾", () => {
    expect(snapToWordEdge(10.08, words, "start", 0.15)).toBe(10);
    expect(snapToWordEdge(11.1, words, "end", 0.15)).toBe(11.2);
  });

  it("容差外原样返回(允许自由落点)", () => {
    expect(snapToWordEdge(15, words, "start", 0.15)).toBe(15);
    expect(snapToWordEdge(10.3, words, "start", 0.1)).toBe(10.3);
  });

  it("多个候选取最近的一个", () => {
    // 10.55 离 10.6(词首)比 10(词首)近
    expect(snapToWordEdge(10.55, words, "start", 0.2)).toBe(10.6);
  });
});

describe("clampDrag", () => {
  const win = { winStartSec: 0, winEndSec: 100 };

  it("起点不越过终点(保住最短时长),终点同理", () => {
    expect(clampDrag("start", 39, 40, win)).toBe(40 - REVIEW_MIN_SEC);
    expect(clampDrag("end", 11, 10, win)).toBe(10 + REVIEW_MIN_SEC);
  });

  it("不出窗口、不超最长时长", () => {
    expect(clampDrag("start", -5, 50, win)).toBe(0);
    expect(clampDrag("end", 200, 50, win)).toBe(100);
    const wide = { winStartSec: 0, winEndSec: 500 };
    expect(clampDrag("end", 400, 50, wide)).toBe(50 + REVIEW_MAX_SEC);
    expect(clampDrag("start", 0, 300, wide)).toBe(300 - REVIEW_MAX_SEC);
  });

  it("合法值原样通过", () => {
    expect(clampDrag("start", 20, 50, win)).toBe(20);
    expect(clampDrag("end", 80, 50, win)).toBe(80);
  });

  it("窗口太窄放不下最短时长时,时长守卫优先", () => {
    const tight = { winStartSec: 9, winEndSec: 11 };
    // 起点被压到 10-3=7,虽在窗口外——不越过对边是硬规则
    expect(clampDrag("start", 9.5, 10, tight)).toBe(10 - REVIEW_MIN_SEC);
  });
});

describe("clipText", () => {
  it("拼接与范围重叠的句子", () => {
    const t = mockTranscript();
    expect(clipText(t, 10, 17)).toBe("第一句话 第二句话");
    expect(clipText(t, 14, 33)).toBe("第二句话 第三句话");
  });

  it("空档范围没有文字", () => {
    expect(clipText(mockTranscript(), 18, 29)).toBe("");
  });
});
