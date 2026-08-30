import { describe, expect, it, vi } from "vitest";
import {
  parseCoverMetricFrames,
  proposeCoverTimes,
  selectQualityCoverTime,
  type CoverFrameMetrics,
} from "../cover-quality";
import type { PeakTrack } from "../audio-peaks";

const healthy = (over: Partial<CoverFrameMetrics> = {}): CoverFrameMetrics => ({
  blur: 8,
  entropy: 0.5,
  yLow: 30,
  yAvg: 125,
  yHigh: 220,
  satAvg: 80,
  yDif: 4,
  ...over,
});

describe("cover candidate proposal", () => {
  it("combines separated audio peaks with uniform fallback coverage", () => {
    const values = new Float32Array(200);
    values[40] = 1;
    values[90] = 0.9;
    values[140] = 0.8;
    const peaks: PeakTrack = { values, startSec: 10, hopSec: 0.1 };
    const candidates = proposeCoverTimes(peaks, [{ startSec: 10, endSec: 30 }], 20);
    expect(candidates.length).toBeGreaterThanOrEqual(5);
    expect(candidates.length).toBeLessThanOrEqual(9);
    expect(candidates.some((candidate) => candidate.source === "audio")).toBe(true);
    expect(candidates.some((candidate) => candidate.source === "uniform")).toBe(true);
    for (let index = 1; index < candidates.length; index++) {
      expect(candidates.slice(0, index).every((item) => Math.abs(item.atSec - candidates[index].atSec) >= 0.7)).toBe(true);
    }
  });
});

describe("cover metric parsing and ranking", () => {
  it("parses complete FFmpeg metadata frames and drops partial blocks", () => {
    const text = [
      "frame:0 pts_time:0",
      "lavfi.blur=4.2",
      "lavfi.entropy.normalized_entropy.normal.Y=0.48",
      "lavfi.signalstats.YLOW=30",
      "lavfi.signalstats.YAVG=120",
      "lavfi.signalstats.YHIGH=210",
      "lavfi.signalstats.SATAVG=90",
      "lavfi.signalstats.YDIF=0",
      "frame:1 pts_time:0.1",
      "lavfi.blur=9",
    ].join("\n");
    expect(parseCoverMetricFrames(text)).toEqual([
      { blur: 4.2, entropy: 0.48, yLow: 30, yAvg: 120, yHigh: 210, satAvg: 90, yDif: 0 },
    ]);
  });

  it("rejects black frames, prefers sharp stable detail, and gives variants the next result", async () => {
    const metrics = new Map<number, CoverFrameMetrics>([
      [1, healthy({ yLow: 0, yAvg: 8, yHigh: 15, entropy: 0.04 })],
      [2, healthy({ blur: 28, entropy: 0.42 })],
      [3, healthy({ blur: 4, entropy: 0.6, yHigh: 230 })],
      [4, healthy({ blur: 5, yDif: 35 })],
    ]);
    const probe = vi.fn(async (_path: string, at: number) => metrics.get(at) ?? null);
    const common = {
      videoPath: "/finished.mp4",
      candidates: [1, 2, 3, 4].map((atSec) => ({ atSec, source: "audio" as const, priority: 0.8 })),
      fallbackSec: 1,
      probe,
    };
    const first = await selectQualityCoverTime(common);
    const second = await selectQualityCoverTime({ ...common, rank: 1 });
    expect(first).toMatchObject({ selectedSec: 3, mode: "quality-ranked", candidatesRejected: 1 });
    expect(second.selectedSec).not.toBe(first.selectedSec);
  });

  it("fails open to the old audio timestamp when metrics are unavailable or unsafe", async () => {
    const candidates = [{ atSec: 2, source: "audio" as const, priority: 1 }];
    const unavailable = await selectQualityCoverTime({
      videoPath: "/missing.mp4",
      candidates,
      fallbackSec: 4.2,
      probe: async () => null,
    });
    expect(unavailable).toMatchObject({ selectedSec: 4.2, mode: "fallback", candidatesEvaluated: 0 });

    const unsafe = await selectQualityCoverTime({
      videoPath: "/flat.mp4",
      candidates,
      fallbackSec: 4.2,
      probe: async () => healthy({ yLow: 5, yAvg: 10, yHigh: 18, entropy: 0.05 }),
    });
    expect(unsafe).toMatchObject({ selectedSec: 4.2, mode: "fallback", candidatesRejected: 1 });
  });
});
