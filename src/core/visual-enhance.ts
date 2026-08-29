/** Deterministic, model-free picture measurements retained from Tier-0 analysis. */
export interface VisualSignalSample {
  /** Absolute source timestamp. */
  t: number;
  /** 10th-percentile luma in FFmpeg's 8-bit signalstats scale. */
  yLow: number;
  /** Mean luma. */
  yAvg: number;
  /** 90th-percentile luma. */
  yHigh: number;
  /** Mean chroma distance / saturation. */
  satAvg: number;
}

export interface VisualEnhancePlan {
  applied: boolean;
  sampleCount: number;
  measurements: {
    lumaLow: number;
    lumaAvg: number;
    lumaHigh: number;
    saturation: number;
  } | null;
  adjustments: {
    brightness: number;
    contrast: number;
    saturation: number;
    gamma: number;
  };
  reasons: Array<"underexposed" | "overexposed" | "flat" | "muted" | "oversaturated">;
}

type PartialSample = Partial<Omit<VisualSignalSample, "t">> & { t: number };

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
const round = (value: number, digits: number): number => Number(value.toFixed(digits));
export const MAX_VISUAL_SIGNAL_SAMPLES = 50_000;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/** Parse the selected signalstats metadata fields printed by the Tier-0 probe. */
export function parseVisualSignalSamples(stderr: string): VisualSignalSample[] {
  const byTime = new Map<string, PartialSample>();
  let currentTime: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const time = line.match(/\bpts_time:([\d.]+)/);
    if (time) {
      const value = Number(time[1]);
      currentTime = Number.isFinite(value) ? value : null;
    }
    const stat = line.match(/lavfi\.signalstats\.(YLOW|YAVG|YHIGH|SATAVG)=([\d.eE+-]+)/);
    if (!stat || currentTime === null) continue;
    const value = Number(stat[2]);
    if (!Number.isFinite(value)) continue;
    const key = currentTime.toFixed(4);
    const sample = byTime.get(key) ?? { t: currentTime };
    if (stat[1] === "YLOW") sample.yLow = value;
    else if (stat[1] === "YAVG") sample.yAvg = value;
    else if (stat[1] === "YHIGH") sample.yHigh = value;
    else sample.satAvg = value;
    byTime.set(key, sample);
  }
  return [...byTime.values()]
    .filter((sample): sample is VisualSignalSample =>
      finite(sample.yLow) && finite(sample.yAvg) && finite(sample.yHigh) && finite(sample.satAvg)
    )
    .sort((a, b) => a.t - b.t);
}

/** Keep one robust sample per source second so multi-hour evidence stays bounded. */
export function compactVisualSignalSamples(samples: VisualSignalSample[]): VisualSignalSample[] {
  const bins = new Map<number, VisualSignalSample[]>();
  for (const sample of samples) {
    if (!finite(sample.t) || sample.t < 0) continue;
    if (![sample.yLow, sample.yAvg, sample.yHigh, sample.satAvg].every(finite)) continue;
    const second = Math.floor(sample.t);
    const bin = bins.get(second) ?? [];
    bin.push(sample);
    bins.set(second, bin);
  }
  const compact = [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([, bin]) => ({
    t: round(median(bin.map((sample) => sample.t)), 3),
    yLow: round(median(bin.map((sample) => sample.yLow)), 2),
    yAvg: round(median(bin.map((sample) => sample.yAvg)), 2),
    yHigh: round(median(bin.map((sample) => sample.yHigh)), 2),
    satAvg: round(median(bin.map((sample) => sample.satAvg)), 2),
  }));
  if (compact.length <= MAX_VISUAL_SIGNAL_SAMPLES) return compact;
  // Preserve the entire source span instead of truncating long recordings.
  return Array.from({ length: MAX_VISUAL_SIGNAL_SAMPLES }, (_, index) =>
    compact[Math.round((index * (compact.length - 1)) / (MAX_VISUAL_SIGNAL_SAMPLES - 1))]
  );
}

const NEUTRAL_ADJUSTMENTS = { brightness: 0, contrast: 1, saturation: 1, gamma: 1 } as const;

/**
 * Derive subtle corrections from robust clip-local measurements. Thresholds
 * intentionally leave ordinary footage untouched; monochrome material is not
 * "re-saturated", and every adjustment has a narrow hard cap.
 */
export function planVisualEnhancement(
  samples: VisualSignalSample[],
  ranges?: Array<{ startSec: number; endSec: number }>
): VisualEnhancePlan {
  const selected = samples.filter((sample) =>
    !ranges || ranges.some((range) => sample.t >= range.startSec && sample.t <= range.endSec)
  );
  if (selected.length < 4) {
    return {
      applied: false,
      sampleCount: selected.length,
      measurements: null,
      adjustments: { ...NEUTRAL_ADJUSTMENTS },
      reasons: [],
    };
  }

  const lumaLow = median(selected.map((sample) => sample.yLow));
  const lumaAvg = median(selected.map((sample) => sample.yAvg));
  const lumaHigh = median(selected.map((sample) => sample.yHigh));
  const saturationMeasured = median(selected.map((sample) => sample.satAvg));
  const span = lumaHigh - lumaLow;
  let brightness = 0;
  let contrast = 1;
  let saturation = 1;
  let gamma = 1;
  const reasons: VisualEnhancePlan["reasons"] = [];

  if (lumaAvg < 82 && lumaHigh < 190) {
    gamma = 1 + clamp((82 - lumaAvg) / 150, 0, 0.08);
    brightness = clamp((70 - lumaAvg) / 1200, 0, 0.02);
    reasons.push("underexposed");
  } else if (lumaAvg > 168 && lumaLow > 35) {
    gamma = 1 - clamp((lumaAvg - 168) / 250, 0, 0.06);
    brightness = -clamp((lumaAvg - 185) / 1200, 0, 0.015);
    reasons.push("overexposed");
  }

  if (span < 80 && lumaLow > 12 && lumaHigh < 235) {
    contrast = 1 + clamp((80 - span) / 200, 0, 0.08);
    reasons.push("flat");
  }
  // SATAVG near zero is commonly intentional monochrome—not missing colour.
  if (saturationMeasured >= 8 && saturationMeasured < 28) {
    saturation = 1 + clamp((28 - saturationMeasured) / 150, 0, 0.08);
    reasons.push("muted");
  } else if (saturationMeasured > 75) {
    saturation = 1 - clamp((saturationMeasured - 75) / 250, 0, 0.08);
    reasons.push("oversaturated");
  }

  const adjustments = {
    brightness: round(brightness, 3),
    contrast: round(contrast, 3),
    saturation: round(saturation, 3),
    gamma: round(gamma, 3),
  };
  const applied =
    Math.abs(adjustments.brightness) >= 0.003 ||
    Math.abs(adjustments.contrast - 1) >= 0.015 ||
    Math.abs(adjustments.saturation - 1) >= 0.02 ||
    Math.abs(adjustments.gamma - 1) >= 0.015;
  return {
    applied,
    sampleCount: selected.length,
    measurements: {
      lumaLow: round(lumaLow, 1),
      lumaAvg: round(lumaAvg, 1),
      lumaHigh: round(lumaHigh, 1),
      saturation: round(saturationMeasured, 1),
    },
    adjustments,
    reasons: applied ? reasons : [],
  };
}

/** Compile the exact bounded adjustment into FFmpeg's per-frame `eq` filter. */
export function visualEnhanceFilter(plan?: VisualEnhancePlan | null): string | null {
  if (!plan?.applied) return null;
  const a = plan.adjustments;
  return [
    `brightness=${a.brightness.toFixed(3)}`,
    `contrast=${a.contrast.toFixed(3)}`,
    `saturation=${a.saturation.toFixed(3)}`,
    `gamma=${a.gamma.toFixed(3)}`,
    "gamma_weight=0.850",
  ].join(":").replace(/^/, "eq=");
}
