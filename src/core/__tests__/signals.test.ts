import { describe, it, expect } from "vitest";
import { parseEbur128, parseShowinfoTimes, loudnessPeaks, cutDensity, planSignalGuidedTimes, loudnessCurve } from "../signals";

describe("parseEbur128", () => {
  it("extracts t/M sample pairs and drops silence-floor readings", () => {
    const stderr = [
      "[Parsed_ebur128_0 @ 0x0] t: 1.0      TARGET:-23 LUFS    M: -25.3 S: -24.0     I: -24.1 LUFS       LRA: 1.2 LU",
      "[Parsed_ebur128_0 @ 0x0] t: 1.1      TARGET:-23 LUFS    M: -12.7 S: -20.0     I: -23.8 LUFS       LRA: 1.3 LU",
      "[Parsed_ebur128_0 @ 0x0] t: 1.2      TARGET:-23 LUFS    M: -120.7 S: -80.0    I: -23.8 LUFS       LRA: 1.3 LU",
    ].join("\n");
    expect(parseEbur128(stderr)).toEqual([
      { t: 1.0, m: -25.3 },
      { t: 1.1, m: -12.7 },
    ]);
  });
});

describe("parseShowinfoTimes", () => {
  it("extracts pts_time values", () => {
    const stderr = "[Parsed_showinfo_2 @ 0x0] n:0 pts:12 pts_time:1.5 ...\n[Parsed_showinfo_2 @ 0x0] n:1 pts:24 pts_time:3.0 ...";
    expect(parseShowinfoTimes(stderr)).toEqual([1.5, 3.0]);
  });
});

describe("loudnessPeaks", () => {
  it("finds sustained bursts above median+rise and merges nearby samples", () => {
    const samples: Array<{ t: number; m: number }> = [];
    for (let t = 0; t < 60; t += 0.5) {
      // baseline -24; burst of -15 between 20..24s
      samples.push({ t, m: t >= 20 && t <= 24 ? -15 : -24 });
    }
    const peaks = loudnessPeaks(samples);
    expect(peaks).toHaveLength(1);
    expect(peaks[0].startSec).toBeCloseTo(20, 1);
    expect(peaks[0].endSec).toBeCloseTo(24, 1);
  });

  it("ignores blips shorter than the minimum duration", () => {
    const samples: Array<{ t: number; m: number }> = [];
    for (let t = 0; t < 60; t += 0.5) samples.push({ t, m: t === 30 ? -10 : -24 });
    expect(loudnessPeaks(samples)).toEqual([]);
  });
});

describe("cutDensity", () => {
  it("flags windows with enough cuts and merges overlapping windows", () => {
    const cuts = [10, 12, 14, 16, 18, 60];
    const dense = cutDensity(cuts, 15, 4);
    expect(dense).toHaveLength(1);
    expect(dense[0].startSec).toBe(10);
    expect(dense[0].endSec).toBe(18);
  });

  it("sparse cuts → no ranges", () => {
    expect(cutDensity([10, 40, 80], 15, 4)).toEqual([]);
  });
});

describe("planSignalGuidedTimes", () => {
  it("弹幕峰值参与引导:采样点密集落进观众炸锅的时段", () => {
    const signals = {
      loudPeaks: [],
      cutDense: [],
      danmakuPeaks: [{ startSec: 300, endSec: 320 }],
    };
    const times = planSignalGuidedTimes(3600, signals, 20, 5, 5);
    const inPeak = times.filter((t) => t >= 300 && t <= 320);
    // 弹幕窗按 5s 步长应拿到多个采样点,远密于均匀网格(3600s/20 点=180s 一个)
    expect(inPeak.length).toBeGreaterThanOrEqual(3);
  });

  it("没有任何信号时退回均匀网格铺满", () => {
    const times = planSignalGuidedTimes(600, { loudPeaks: [], cutDense: [] }, 10, 5, 5);
    expect(times.length).toBe(10);
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1]);
  });
});

describe("loudnessCurve", () => {
  it("每格取窗内最大响度并按分位归一;峰值格显著高于底噪格", () => {
    const samples: Array<{ t: number; m: number }> = [];
    for (let t = 0; t < 600; t += 0.5) samples.push({ t, m: -30 + Math.sin(t) * 2 });
    for (let t = 300; t < 310; t += 0.5) samples.push({ t, m: -12 });
    const c = loudnessCurve(samples, 600, 120);
    expect(c).toHaveLength(120);
    const peakBin = c[Math.floor((305 / 600) * 120)];
    const quietBin = c[Math.floor((100 / 600) * 120)];
    expect(peakBin).toBeGreaterThan(quietBin + 0.3);
    for (const v of c) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("采样太少/时长非法返回安全值", () => {
    expect(loudnessCurve([], 600, 120)).toEqual(new Array(120).fill(0));
    expect(loudnessCurve([{ t: 1, m: -20 }], 0, 120)).toEqual([]);
  });
});
