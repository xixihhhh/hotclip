import { describe, expect, it } from "vitest";
import {
  compactVisualSignalSamples,
  MAX_VISUAL_SIGNAL_SAMPLES,
  parseVisualSignalSamples,
  planVisualEnhancement,
  visualEnhanceFilter,
  type VisualSignalSample,
} from "../visual-enhance";

const samples = (values: Partial<Omit<VisualSignalSample, "t">> = {}, count = 6): VisualSignalSample[] =>
  Array.from({ length: count }, (_, t) => ({
    t,
    yLow: 24,
    yAvg: 116,
    yHigh: 210,
    satAvg: 42,
    ...values,
  }));

describe("visual signal evidence", () => {
  it("parses repeated metadata blocks and keeps only complete chronological frames", () => {
    const stderr = [
      "frame:0 pts:0 pts_time:0.000",
      "lavfi.signalstats.YLOW=11",
      "frame:0 pts:0 pts_time:0.000",
      "lavfi.signalstats.YAVG=60",
      "frame:0 pts:0 pts_time:0.000",
      "lavfi.signalstats.YHIGH=140",
      "frame:0 pts:0 pts_time:0.000",
      "lavfi.signalstats.SATAVG=18.5",
      "frame:1 pts:4 pts_time:1.000",
      "lavfi.signalstats.YLOW=20",
    ].join("\n");
    expect(parseVisualSignalSamples(stderr)).toEqual([
      { t: 0, yLow: 11, yAvg: 60, yHigh: 140, satAvg: 18.5 },
    ]);
  });

  it("compacts four-frame probe output to robust one-per-second evidence", () => {
    const dense = [
      { t: 0, yLow: 10, yAvg: 40, yHigh: 100, satAvg: 20 },
      { t: 0.25, yLow: 14, yAvg: 44, yHigh: 104, satAvg: 24 },
      { t: 1, yLow: 30, yAvg: 100, yHigh: 190, satAvg: 40 },
    ];
    expect(compactVisualSignalSamples(dense)).toEqual([
      { t: 0.125, yLow: 12, yAvg: 42, yHigh: 102, satAvg: 22 },
      { t: 1, yLow: 30, yAvg: 100, yHigh: 190, satAvg: 40 },
    ]);
  });

  it("caps extreme recordings while retaining first and final source coverage", () => {
    const long = samples({}, MAX_VISUAL_SIGNAL_SAMPLES + 2);
    const compact = compactVisualSignalSamples(long);
    expect(compact).toHaveLength(MAX_VISUAL_SIGNAL_SAMPLES);
    expect(compact[0].t).toBe(0);
    expect(compact.at(-1)?.t).toBe(MAX_VISUAL_SIGNAL_SAMPLES + 1);
  });
});

describe("content-adaptive picture plan", () => {
  it("leaves healthy footage byte-path neutral", () => {
    const plan = planVisualEnhancement(samples());
    expect(plan).toMatchObject({ applied: false, sampleCount: 6, reasons: [] });
    expect(plan.adjustments).toEqual({ brightness: 0, contrast: 1, saturation: 1, gamma: 1 });
    expect(visualEnhanceFilter(plan)).toBeNull();
  });

  it("brightens flat underexposed muted footage within hard caps", () => {
    const plan = planVisualEnhancement(samples({ yLow: 20, yAvg: 55, yHigh: 90, satAvg: 16 }));
    expect(plan.applied).toBe(true);
    expect(plan.reasons).toEqual(["underexposed", "flat", "muted"]);
    expect(plan.adjustments.brightness).toBeGreaterThan(0);
    expect(plan.adjustments.brightness).toBeLessThanOrEqual(0.02);
    expect(plan.adjustments.contrast).toBeLessThanOrEqual(1.08);
    expect(plan.adjustments.saturation).toBeLessThanOrEqual(1.08);
    expect(plan.adjustments.gamma).toBeLessThanOrEqual(1.08);
    expect(visualEnhanceFilter(plan)).toMatch(/^eq=brightness=/);
  });

  it("restrains washed, oversaturated footage", () => {
    const plan = planVisualEnhancement(samples({ yLow: 70, yAvg: 195, yHigh: 235, satAvg: 100 }));
    expect(plan.applied).toBe(true);
    expect(plan.reasons).toContain("overexposed");
    expect(plan.reasons).toContain("oversaturated");
    expect(plan.adjustments.brightness).toBeGreaterThanOrEqual(-0.015);
    expect(plan.adjustments.gamma).toBeGreaterThanOrEqual(0.94);
    expect(plan.adjustments.saturation).toBeGreaterThanOrEqual(0.92);
    expect(plan.adjustments.saturation).toBeLessThan(1);
  });

  it("does not invent colour in intentional monochrome footage", () => {
    const plan = planVisualEnhancement(samples({ satAvg: 1 }));
    expect(plan.adjustments.saturation).toBe(1);
    expect(plan.reasons).not.toContain("muted");
  });

  it("uses only retained source ranges and skips weak evidence", () => {
    const source = [
      ...samples({ yLow: 20, yAvg: 55, yHigh: 105, satAvg: 16 }, 6),
      ...samples({}, 6).map((sample) => ({ ...sample, t: sample.t + 20 })),
    ];
    expect(planVisualEnhancement(source, [{ startSec: 20, endSec: 25 }]).applied).toBe(false);
    expect(planVisualEnhancement(source, [{ startSec: 0, endSec: 2 }])).toMatchObject({ applied: false, sampleCount: 3, measurements: null });
  });
});
