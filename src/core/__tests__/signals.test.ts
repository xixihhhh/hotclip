import { describe, it, expect } from "vitest";
import { parseEbur128, parseShowinfoTimes, loudnessPeaks, cutDensity } from "../signals";

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
