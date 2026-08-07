import { describe, it, expect } from "vitest";
import { selectionToPieces, pickVerdict, MANUAL_MAX_PIECES, MANUAL_MIN_SEC, MANUAL_MAX_SEC } from "../../shared/pick";
import type { TranscriptSegment } from "../../shared/api-types";

// 六句连排:[0-4] [4-8] [8-12] [12-16] [16-20] [20-24]
const segs: TranscriptSegment[] = [0, 1, 2, 3, 4, 5].map((i) => ({
  id: i + 1,
  startSec: i * 4,
  endSec: i * 4 + 4,
  text: `第${i + 1}句`,
  words: [],
}));

const sel = (...ids: number[]): Set<number> => new Set(ids);

describe("selectionToPieces", () => {
  it("相邻选中并成一段", () => {
    expect(selectionToPieces(segs, sel(2, 3, 4))).toEqual([{ startSec: 4, endSec: 16 }]);
  });

  it("断开的选中各自成段,顺序即时间序", () => {
    expect(selectionToPieces(segs, sel(1, 2, 5, 6))).toEqual([
      { startSec: 0, endSec: 8 },
      { startSec: 16, endSec: 24 },
    ]);
  });

  it("中间被跳过的句子绝不并进来——跳过是用户的明确决定", () => {
    // 句 3 被跳过,哪怕它只有 4 秒、间隔为 0,也必须留成两段
    const pieces = selectionToPieces(segs, sel(2, 4));
    expect(pieces).toEqual([
      { startSec: 4, endSec: 8 },
      { startSec: 12, endSec: 16 },
    ]);
  });

  it("空选择返回空", () => {
    expect(selectionToPieces(segs, sel())).toEqual([]);
  });

  it("选择集里不存在的 id 不影响结果", () => {
    expect(selectionToPieces(segs, sel(2, 999))).toEqual([{ startSec: 4, endSec: 8 }]);
  });
});

describe("pickVerdict", () => {
  const p = (startSec: number, endSec: number): { startSec: number; endSec: number } => ({ startSec, endSec });

  it("空选择 → empty", () => {
    expect(pickVerdict([], 0)).toBe("empty");
  });

  it("过短/过长按时长档拒绝", () => {
    expect(pickVerdict([p(0, 2)], MANUAL_MIN_SEC - 0.5)).toBe("tooShort");
    expect(pickVerdict([p(0, 130)], MANUAL_MAX_SEC + 1)).toBe("tooLong");
  });

  it("段数超过手动上限 → tooMany", () => {
    const many = Array.from({ length: MANUAL_MAX_PIECES + 1 }, (_, i) => p(i * 10, i * 10 + 4));
    expect(pickVerdict(many, 36)).toBe("tooMany");
  });

  it("正常范围 → ok(手动上限内的多段也放行——AI 的 4 段护栏不管手动)", () => {
    const many = Array.from({ length: MANUAL_MAX_PIECES }, (_, i) => p(i * 10, i * 10 + 4));
    expect(pickVerdict(many, 32)).toBe("ok");
    expect(pickVerdict([p(0, 30)], 30)).toBe("ok");
  });
});
