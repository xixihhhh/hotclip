import { describe, it, expect } from "vitest";
import { adjustClipBoundary, adjustCandidateBoundary } from "../../shared/boundary";
import type { Transcript } from "../../shared/api-types";

// four 4s sentences back to back: [0-4] [4-8] [8-12] [12-16]
const tx: Transcript = {
  language: "zh",
  engine: "test",
  durationSec: 16,
  segments: [0, 1, 2, 3].map((i) => ({
    id: i + 1,
    startSec: i * 4,
    endSec: i * 4 + 4,
    text: `第${i + 1}句`,
    words: [],
  })),
};

describe("adjustClipBoundary", () => {
  const clip = { startSec: 4, endSec: 12 }; // sentences 2+3

  it("start -1 pulls the previous sentence in", () => {
    const r = adjustClipBoundary(tx, clip, "start", -1)!;
    expect(r.startSec).toBe(0);
    expect(r.text).toBe("第1句 第2句 第3句");
  });

  it("start +1 drops the first sentence", () => {
    const r = adjustClipBoundary(tx, clip, "start", 1)!;
    expect(r.startSec).toBe(8);
    expect(r.text).toBe("第3句");
  });

  it("end +1 pulls the next sentence in", () => {
    const r = adjustClipBoundary(tx, clip, "end", 1)!;
    expect(r.endSec).toBe(16);
    expect(r.text).toBe("第2句 第3句 第4句");
  });

  it("end -1 drops the last sentence", () => {
    const r = adjustClipBoundary(tx, clip, "end", -1)!;
    expect(r.endSec).toBe(8);
    expect(r.text).toBe("第2句");
  });

  it("refuses to move past the transcript edges", () => {
    expect(adjustClipBoundary(tx, { startSec: 0, endSec: 8 }, "start", -1)).toBeNull();
    expect(adjustClipBoundary(tx, { startSec: 8, endSec: 16 }, "end", 1)).toBeNull();
  });

  it("refuses to collapse a single-sentence clip", () => {
    expect(adjustClipBoundary(tx, { startSec: 4, endSec: 8 }, "start", 1)).toBeNull();
    expect(adjustClipBoundary(tx, { startSec: 4, endSec: 8 }, "end", -1)).toBeNull();
  });

  it("refuses durations below the minimum", () => {
    // dropping one sentence from a 2-sentence clip leaves 4s ≥ 3s min — fine;
    // but a sub-3s result must be rejected
    const shortTx: Transcript = {
      ...tx,
      segments: [
        { id: 1, startSec: 0, endSec: 1, text: "a", words: [] },
        { id: 2, startSec: 1, endSec: 2, text: "b", words: [] },
      ],
    };
    expect(adjustClipBoundary(shortTx, { startSec: 0, endSec: 2 }, "end", -1)).toBeNull();
  });
});

describe("adjustCandidateBoundary(拼接片)", () => {
  // 十句连排,每句 4 秒:[0-4] … [36-40]
  const tenTx: Transcript = {
    language: "zh",
    engine: "test",
    durationSec: 40,
    segments: Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      startSec: i * 4,
      endSec: i * 4 + 4,
      text: `第${i + 1}句`,
      words: [],
    })),
  };

  it("手动 5 段片调边后仍是 5 段——不许被 AI 的 4 段护栏悄悄砍", () => {
    // 选了句 1/3/5/7/9(隔句选):5 个不相邻的段
    const pieces = [0, 2, 4, 6, 8].map((i) => ({ startSec: i * 4, endSec: i * 4 + 4 }));
    const clip = { startSec: 0, endSec: 36, pieces };
    const adj = adjustCandidateBoundary(tenTx, clip, "end", 1);
    expect(adj).not.toBeNull();
    // 尾段向后扩一句:最后一段 [32,36] → [32,40],其余四段原样保留
    expect(adj!.pieces).toHaveLength(5);
    expect(adj!.pieces![4]).toEqual({ startSec: 32, endSec: 40 });
    expect(adj!.pieces!.slice(0, 4)).toEqual(pieces.slice(0, 4));
  });

  it("只动首/尾段的边,中间段一动不动", () => {
    const pieces = [
      { startSec: 4, endSec: 8 },
      { startSec: 16, endSec: 20 },
      { startSec: 28, endSec: 32 },
    ];
    const adj = adjustCandidateBoundary(tenTx, { startSec: 4, endSec: 32, pieces }, "start", -1);
    expect(adj).not.toBeNull();
    expect(adj!.pieces).toEqual([
      { startSec: 0, endSec: 8 },
      { startSec: 16, endSec: 20 },
      { startSec: 28, endSec: 32 },
    ]);
  });
});
