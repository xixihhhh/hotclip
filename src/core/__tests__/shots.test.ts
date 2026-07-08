import { describe, it, expect } from "vitest";
import {
  decodeBoundaries,
  snapClipToShots,
  snapContextAround,
  TRANSNET_FPS,
  SNAP_MAX_OUT_SEC,
  SNAP_MAX_IN_SEC,
} from "../shots";

describe("decodeBoundaries", () => {
  // 构造 n 帧概率序列,指定帧置为高概率
  const probsOf = (n: number, spikes: Record<number, number>) => {
    const p = new Array(n).fill(0.01);
    for (const [i, v] of Object.entries(spikes)) p[Number(i)] = v;
    return p;
  };

  it("单帧尖峰 → 边界在峰值帧与下一帧之间", () => {
    // 帧 99 是旧镜头最后一帧 → 边界 = 100/25 = 4.0s
    expect(decodeBoundaries(probsOf(300, { 99: 0.97 }))).toEqual([4]);
  });

  it("连续超阈值取峰值帧,只报一个边界", () => {
    const p = probsOf(300, { 98: 0.6, 99: 0.95, 100: 0.7 });
    expect(decodeBoundaries(p)).toEqual([4]);
  });

  it("多个独立边界按时间顺序输出", () => {
    expect(decodeBoundaries(probsOf(300, { 99: 0.97, 199: 0.9 }))).toEqual([4, 8]);
  });

  it("低于阈值不产生边界;空序列安全", () => {
    expect(decodeBoundaries(probsOf(300, { 99: 0.49 }))).toEqual([]);
    expect(decodeBoundaries([])).toEqual([]);
  });

  it("自定义帧率参与换算", () => {
    expect(decodeBoundaries(probsOf(100, { 49: 0.9 }), 50)).toEqual([1]);
    expect(TRANSNET_FPS).toBe(25);
  });
});

describe("snapClipToShots", () => {
  it("外扩:起点吸到略早的边界,终点吸到略晚的边界", () => {
    const r = snapClipToShots(10.3, 40.5, [10.0, 41.0]);
    expect(r.snapped).toBe(true);
    expect(r.startSec).toBe(10.0);
    expect(r.endSec).toBe(41.0);
    expect(r.startDeltaSec).toBeCloseTo(-0.3);
    expect(r.endDeltaSec).toBeCloseTo(0.5);
  });

  it("超出外扩上限的边界不吸附", () => {
    const r = snapClipToShots(10.3, 40.5, [10.3 - SNAP_MAX_OUT_SEC - 0.1, 40.5 + SNAP_MAX_OUT_SEC + 0.1]);
    expect(r.snapped).toBe(false);
    expect(r.startSec).toBe(10.3);
  });

  it("内收:必须已知片内首/末词且留出间隙", () => {
    // 未提供词信息 → 内收被拒
    expect(snapClipToShots(10, 40, [10.2, 39.8]).snapped).toBe(false);
    // 提供词信息且边界在词外 → 允许内收
    const ok = snapClipToShots(10, 40, [10.2, 39.8], {
      firstWordStartSec: 10.5,
      lastWordEndSec: 39.5,
    });
    expect(ok.startSec).toBe(10.2);
    expect(ok.endSec).toBe(39.8);
    // 边界会切到词 → 拒绝
    const cut = snapClipToShots(10, 40, [10.2], { firstWordStartSec: 10.21 });
    expect(cut.snapped).toBe(false);
  });

  it("内收幅度受 SNAP_MAX_IN_SEC 限制", () => {
    const r = snapClipToShots(10, 40, [10 + SNAP_MAX_IN_SEC + 0.1], {
      firstWordStartSec: 12,
    });
    expect(r.snapped).toBe(false);
  });

  it("外扩不越过片外紧邻的词", () => {
    // 上一个词 9.9s 才说完,10.0 的边界离词只有 0.1s>guard → 允许
    const ok = snapClipToShots(10.3, 40, [10.0], { prevWordEndSec: 9.9 });
    expect(ok.startSec).toBe(10.0);
    // 词一直说到 9.98 → 10.0 距词 0.02 < guard → 拒绝
    const blocked = snapClipToShots(10.3, 40, [10.0], { prevWordEndSec: 9.98 });
    expect(blocked.snapped).toBe(false);
    // 终点同理
    const endBlocked = snapClipToShots(10, 40.5, [41.0], { nextWordStartSec: 41.01 });
    expect(endBlocked.snapped).toBe(false);
  });

  it("已在边界上(位移过小)不重切", () => {
    expect(snapClipToShots(10.0, 40.0, [10.02, 40.03]).snapped).toBe(false);
  });

  it("时长守卫:吸附不会把片压到过短", () => {
    // 1.2s 的片,两侧各向内收会剩 0.5s → 放弃吸附
    const r = snapClipToShots(10, 11.2, [10.3, 10.9], {
      firstWordStartSec: 10.5,
      lastWordEndSec: 10.7,
    });
    expect(r.endSec - r.startSec).toBeGreaterThanOrEqual(1);
  });

  it("空边界或非法区间安全返回", () => {
    expect(snapClipToShots(10, 40, []).snapped).toBe(false);
    expect(snapClipToShots(40, 10, [20]).snapped).toBe(false);
  });
});

describe("snapContextAround", () => {
  const w = (startSec: number, endSec: number) => ({ startSec, endSec });
  const words = [w(1, 1.5), w(2, 2.5), w(9, 9.5), w(10.5, 11), w(20, 20.5), w(41, 41.5)];

  it("找到片外紧邻词:上一个词的结束、下一个词的开始", () => {
    expect(snapContextAround(words, 10, 40)).toEqual({
      prevWordEndSec: 9.5,
      nextWordStartSec: 41,
    });
  });

  it("片外无词时为 null(允许任意外扩)", () => {
    expect(snapContextAround(words, 0.5, 50)).toEqual({
      prevWordEndSec: null,
      nextWordStartSec: null,
    });
    expect(snapContextAround([], 10, 40)).toEqual({
      prevWordEndSec: null,
      nextWordStartSec: null,
    });
  });

  it("跨在边界上的词不算片外词", () => {
    // 10.5-11 的词在片内,不应作为 prev/next
    const ctx = snapContextAround(words, 10.2, 40);
    expect(ctx.prevWordEndSec).toBe(9.5);
  });
});
