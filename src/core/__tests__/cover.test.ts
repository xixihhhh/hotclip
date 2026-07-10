import { describe, it, expect } from "vitest";
import { pickCoverTime, fallbackCoverTime } from "../cover";
import type { PeakTrack } from "../audio-peaks";

/** 构造峰值轨:每 0.1s 一块,values 直接传入,startSec 为源起点。 */
function track(values: number[], startSec: number): PeakTrack {
  return { values: Float32Array.from(values), startSec, hopSec: 0.1 };
}

describe("fallbackCoverTime", () => {
  it("hook 后 0.8s,短片夹到时长内", () => {
    expect(fallbackCoverTime(20)).toBe(0.8);
    expect(fallbackCoverTime(0.5)).toBeCloseTo(0.4);
  });
});

describe("pickCoverTime", () => {
  // 切片 [10, 20],峰值在源 15s 处
  const ranges = [{ startSec: 10, endSec: 20 }];

  it("选切片内响度最高时刻,映射到输出时间", () => {
    const values = Array.from({ length: 100 }, (_, i) => (i === 50 ? 0.9 : 0.2)); // 源 15.0s
    const at = pickCoverTime(track(values, 10), ranges, 10);
    expect(at).toBeCloseTo(5.0, 1); // 15s - 10s = 输出 5s
  });

  it("避开成片首尾守卫区:峰值贴边时不选", () => {
    const values = Array.from({ length: 100 }, (_, i) => (i === 1 ? 0.9 : i === 50 ? 0.5 : 0.1)); // 最响在 10.1s(输出 0.1s 贴边)
    const at = pickCoverTime(track(values, 10), ranges, 10);
    expect(at).toBeCloseTo(5.0, 1); // 退而选次响的中部
  });

  it("跳剪多段:被剪掉区间的峰值不参与,输出时间按段累计", () => {
    // 段1 [10,13],段2 [17,20];最响在被剪掉的 15s,段2 里 18s 次响
    const values = Array.from({ length: 100 }, (_, i) => {
      const t = 10 + i * 0.1;
      if (Math.abs(t - 15) < 0.05) return 1.0;
      if (Math.abs(t - 18) < 0.05) return 0.7;
      return 0.1;
    });
    const at = pickCoverTime(track(values, 10), [
      { startSec: 10, endSec: 13 },
      { startSec: 17, endSec: 20 },
    ], 6);
    expect(at).toBeCloseTo(4.0, 1); // 段1 占 3s,18s 在段2 内偏移 1s → 输出 4s
  });

  it("无峰值轨/全静音/超短片回退固定帧", () => {
    expect(pickCoverTime(undefined, ranges, 10)).toBe(0.8);
    const silent = Array.from({ length: 100 }, () => 0.01);
    expect(pickCoverTime(track(silent, 10), ranges, 10)).toBe(0.8);
    expect(pickCoverTime(track([0.9], 10), ranges, 0.6)).toBeCloseTo(0.5);
  });
});
