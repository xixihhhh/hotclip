import { describe, it, expect } from "vitest";
import { refineWordTimings, toAlignUnits, ALIGN_MIN_MATCH_FRAC } from "../align";
import type { TranscriptWord } from "../../shared/api-types";

function w(text: string, startSec: number, endSec: number): TranscriptWord {
  return { text, startSec, endSec };
}

describe("toAlignUnits(归一化对齐单元)", () => {
  it("CJK 逐字、拉丁/数字逐字符,标点空白丢弃,记录归属下标", () => {
    const units = toAlignUnits([{ text: "你好," }, { text: "AI 99!" }]);
    expect(units.map((u) => u.ch).join("")).toBe("你好ai99");
    expect(units.map((u) => u.idx)).toEqual([0, 0, 1, 1, 1, 1]);
  });
});

describe("refineWordTimings(二遍对齐时间重映射)", () => {
  it("全文匹配:词表整体采纳参考时间(文本原样保留)", () => {
    // 主转写时间整体偏了 0.5s;参考流是逐字 token 带准确时间
    const words = [w("今天", 10.5, 11.1), w("只要", 11.1, 11.7), w("九块九", 11.7, 12.6)];
    const ref = [
      w("今", 10.0, 10.3), w("天", 10.3, 10.6),
      w("只", 10.6, 10.9), w("要", 10.9, 11.2),
      w("九", 11.2, 11.5), w("块", 11.5, 11.8), w("九", 11.8, 12.1),
    ];
    const res = refineWordTimings(words, ref);
    expect(res.matchedFrac).toBe(1);
    expect(res.words.map((x) => x.text)).toEqual(["今天", "只要", "九块九"]);
    expect(res.words[0].startSec).toBeCloseTo(10.0, 5);
    expect(res.words[0].endSec).toBeCloseTo(10.6, 5);
    expect(res.words[2].startSec).toBeCloseTo(11.2, 5);
    expect(res.words[2].endSec).toBeCloseTo(12.1, 5);
    expect(res.words.every((x) => x.timingSource === "aligned")).toBe(true);
    expect(res.alignedWords).toBe(3);
  });

  it("参考流有幻觉/漏字仍能对齐,未命中词内插进前后锚点", () => {
    const words = [w("你好", 10, 10.6), w("世界", 10.6, 11.2), w("再见", 11.2, 11.8)];
    // 参考流:「世界」没识别出来,但「你好」「再见」时间准确
    const ref = [w("你", 9.5, 9.8), w("好", 9.8, 10.1), w("再", 11.5, 11.8), w("见", 11.8, 12.1)];
    const res = refineWordTimings(words, ref);
    expect(res.words[0].startSec).toBeCloseTo(9.5, 5);
    expect(res.words[2].startSec).toBeCloseTo(11.5, 5);
    // 「世界」内插在 10.1(前锚点尾)与 11.5(后锚点头)之间且单调
    expect(res.words[1].startSec).toBeGreaterThanOrEqual(10.1 - 1e-6);
    expect(res.words[1].endSec).toBeLessThanOrEqual(11.5 + 1e-6);
    expect(res.matchedFrac).toBeCloseTo(4 / 6, 5);
    expect(res.words[1].timingSource).toBe("interpolated");
    expect(res.interpolatedWords).toBe(1);
  });

  it("完全对不上:matchedFrac 低于门槛(调用方回退)", () => {
    const words = [w("完全", 0, 0.5), w("无关", 0.5, 1)];
    const ref = [w("音", 0, 0.3), w("乐", 0.3, 0.6)];
    const res = refineWordTimings(words, ref);
    expect(res.matchedFrac).toBeLessThan(ALIGN_MIN_MATCH_FRAC);
  });

  it("重映射后时间严格单调、无零长词", () => {
    const words = [w("啊", 5, 5.1), w("这个", 5.1, 5.5), w("产品", 5.5, 6)];
    const ref = [w("这", 4.0, 4.2), w("个", 4.2, 4.4), w("产", 4.4, 4.6), w("品", 4.6, 4.8)];
    const res = refineWordTimings(words, ref);
    for (let i = 0; i < res.words.length; i++) {
      expect(res.words[i].endSec).toBeGreaterThan(res.words[i].startSec);
      if (i > 0) expect(res.words[i].startSec).toBeGreaterThanOrEqual(res.words[i - 1].endSec - 1e-3);
    }
  });
});
