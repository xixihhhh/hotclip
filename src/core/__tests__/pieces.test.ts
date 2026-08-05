import { describe, it, expect } from "vitest";
import {
  normalizePieces,
  piecesDurationSec,
  clipDurationSec,
  isStitched,
  pieceCutSpans,
  planFromPieces,
  withinOnePiece,
  wordsInPieces,
  MIN_PIECE_SEC,
  MAX_PIECES,
  PIECE_PAD_AFTER_SEC,
  PIECE_PAD_BEFORE_SEC,
} from "../../shared/pieces";
import { subtractSpans, computeJumpCut } from "../gaps";

const p = (startSec: number, endSec: number): { startSec: number; endSec: number } => ({ startSec, endSec });

describe("normalizePieces", () => {
  it("按时间排序,乱序输入也还原成播放顺序", () => {
    expect(normalizePieces([p(100, 110), p(10, 20)])).toEqual([p(10, 20), p(100, 110)]);
  });

  it("丢掉非法区间(倒挂/NaN)", () => {
    expect(normalizePieces([p(20, 10), p(NaN, 5), p(10, 20)])).toEqual([p(10, 20)]);
  });

  it("重叠或紧挨着的两段合并——中间那点空隙不值得剪一刀", () => {
    expect(normalizePieces([p(10, 20), p(18, 26)])).toEqual([p(10, 26)]);
    expect(normalizePieces([p(10, 20), p(20.5, 26)])).toEqual([p(10, 26)]);
  });

  it("间隔够大才算两段", () => {
    expect(normalizePieces([p(10, 20), p(30, 40)])).toHaveLength(2);
  });

  it("过短碎片丢掉", () => {
    const out = normalizePieces([p(10, 20), p(100, 100 + MIN_PIECE_SEC - 0.5)]);
    expect(out).toEqual([p(10, 20)]);
  });

  it("全都过短时保留最长的一段(退化成单段,而不是把整条抹掉)", () => {
    const out = normalizePieces([p(10, 11), p(100, 101.5)]);
    expect(out).toEqual([p(100, 101.5)]);
  });

  it("超额时按时长取前 N,再按时间排回", () => {
    const out = normalizePieces([p(0, 3), p(100, 120), p(200, 210), p(300, 330), p(400, 415)]);
    expect(out).toHaveLength(MAX_PIECES);
    // 最短的 (0,3) 被淘汰;剩下的仍按时间序
    expect(out[0]).toEqual(p(100, 120));
    expect(out.map((x) => x.startSec)).toEqual([...out.map((x) => x.startSec)].sort((a, b) => a - b));
  });

  it("空输入返回空", () => {
    expect(normalizePieces([])).toEqual([]);
  });
});

describe("时长口径", () => {
  it("拼接片的成片时长是各段之和,不是跨度", () => {
    const pieces = [p(10, 20), p(600, 615)];
    expect(piecesDurationSec(pieces)).toBe(25);
    expect(clipDurationSec({ startSec: 10, endSec: 615, pieces })).toBe(25);
  });

  it("单段/无段清单按区间长度", () => {
    expect(clipDurationSec({ startSec: 10, endSec: 25 })).toBe(15);
    expect(clipDurationSec({ startSec: 10, endSec: 25, pieces: [p(10, 25)] })).toBe(15);
  });

  it("isStitched 只认 ≥2 段", () => {
    expect(isStitched(undefined)).toBe(false);
    expect(isStitched([p(1, 2)])).toBe(false);
    expect(isStitched([p(1, 2), p(9, 10)])).toBe(true);
  });
});

describe("pieceCutSpans", () => {
  it("段间空隙两头各留余白——拼接处不贴着词硬切", () => {
    const spans = pieceCutSpans([p(10, 20), p(100, 110)]);
    expect(spans).toEqual([{ startSec: 20 + PIECE_PAD_AFTER_SEC, endSec: 100 - PIECE_PAD_BEFORE_SEC }]);
  });

  it("单段没有空隙", () => {
    expect(pieceCutSpans([p(10, 20)])).toEqual([]);
  });

  it("三段产出两条空隙", () => {
    expect(pieceCutSpans([p(0, 10), p(50, 60), p(200, 210)])).toHaveLength(2);
  });

  it("喂给 subtractSpans 后剩下的正是各段(含余白)", () => {
    const pieces = [p(10, 20), p(100, 110)];
    const kept = subtractSpans([{ startSec: 10, endSec: 110 }], pieceCutSpans(pieces));
    expect(kept).toHaveLength(2);
    expect(kept[0].startSec).toBe(10);
    expect(kept[0].endSec).toBeCloseTo(20 + PIECE_PAD_AFTER_SEC, 6);
    expect(kept[1].startSec).toBeCloseTo(100 - PIECE_PAD_BEFORE_SEC, 6);
    expect(kept[1].endSec).toBe(110);
  });
});

describe("planFromPieces", () => {
  it("段清单即保留区间,断行点落在每段接缝的输出时刻", () => {
    const plan = planFromPieces([p(10, 20), p(100, 115)]);
    expect(plan.segments).toEqual([p(10, 20), p(100, 115)]);
    expect(plan.durationSec).toBe(25);
    expect(plan.breaks).toEqual([10]);
    expect(plan.removedSec).toBe(105 - 25 + 0); // 跨度 105 - 成片 25
    expect(plan.words).toEqual([]);
  });

  it("三段有两个断行点", () => {
    expect(planFromPieces([p(0, 5), p(50, 58), p(100, 103)]).breaks).toEqual([5, 13]);
  });
});

describe("拼接复用跳剪机器(端到端口径)", () => {
  // 两段:10-14s 和 100-104s,各 4 个词;段间空隙当强制剪除区间喂进去
  const words = [
    { text: "前", startSec: 10, endSec: 11 },
    { text: "面", startSec: 11, endSec: 12 },
    { text: "这", startSec: 12, endSec: 13 },
    { text: "句", startSec: 13, endSec: 14 },
    { text: "后", startSec: 100, endSec: 101 },
    { text: "面", startSec: 101, endSec: 102 },
    { text: "打", startSec: 102, endSec: 103 },
    { text: "脸", startSec: 103, endSec: 104 },
  ];
  const pieces = [p(10, 14), p(100, 104)];

  it("不开跳剪时也剪出两段,词按压缩后的输出时间轴重排", () => {
    const plan = computeJumpCut(words, 10, 104, {
      forceCutSpans: pieceCutSpans(pieces),
      gapThresholdSec: Infinity, // 跳剪关着——只有拼接空隙该被剪
    });
    expect(plan.segments).toHaveLength(2);
    // 成片时长 ≈ 两段之和(含首尾留白),远小于 94 秒的跨度
    expect(plan.durationSec).toBeLessThan(12);
    expect(plan.breaks).toHaveLength(1);
    // 第二段的词被平移到接缝之后,不再带着原片的 100 秒
    const last = plan.words[plan.words.length - 1];
    expect(last.text).toBe("脸");
    expect(last.endSec).toBeLessThan(12);
    expect(plan.words.map((w) => w.text).join("")).toBe("前面这句后面打脸");
  });

  it("空隙里的内容一秒都没进成片", () => {
    const plan = computeJumpCut(words, 10, 104, {
      forceCutSpans: pieceCutSpans(pieces),
      gapThresholdSec: Infinity,
    });
    const covered = (t: number): boolean => plan.segments.some((s) => t >= s.startSec && t <= s.endSec);
    expect(covered(50)).toBe(false);
    expect(covered(99)).toBe(false);
    expect(covered(12)).toBe(true);
    expect(covered(102)).toBe(true);
  });
});

describe("withinOnePiece", () => {
  const pieces = [p(10, 20), p(100, 110)];
  it("整个落在某段内才算数", () => {
    expect(withinOnePiece(pieces, 11, 15)).toBe(true);
    expect(withinOnePiece(pieces, 100, 110)).toBe(true);
  });
  it("跨越空隙的区间不算——高潮前置照抄这段会把剪掉的内容放回成片", () => {
    expect(withinOnePiece(pieces, 15, 105)).toBe(false);
    expect(withinOnePiece(pieces, 19, 21)).toBe(false);
  });
});

describe("wordsInPieces", () => {
  it("只留落在段内的词,空隙里的词全部丢掉", () => {
    const words = [
      { text: "a", startSec: 11, endSec: 12 },
      { text: "b", startSec: 50, endSec: 51 },
      { text: "c", startSec: 101, endSec: 102 },
    ];
    expect(wordsInPieces(words, [p(10, 20), p(100, 110)]).map((w) => w.text)).toEqual(["a", "c"]);
  });

  it("按词中点判定,压在边界上的词不会两边都算", () => {
    const words = [{ text: "x", startSec: 19.6, endSec: 20.4 }];
    expect(wordsInPieces(words, [p(10, 20)])).toHaveLength(1); // 中点 20.0 仍在段内
  });
});
