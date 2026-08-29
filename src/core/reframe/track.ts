/**
 * Face-track → crop-window planning (pure, unit-testable).
 *
 * Doctrine (AutoFlip-style, per 2026 research): "don't move unless you must".
 * Per shot segment, pick one of three modes:
 *  - locked: all visible faces fit one safe crop → one constant crop
 *  - pan: steady drift → linear interpolation between endpoints
 *  - track: real movement → One Euro filtered keyframes with a dead zone
 *  - recover: a sustained detection loss eases the crop back toward centre
 * Falls back to center crop (null) when faces are too sparse to trust.
 */

export interface FaceSample {
  /** Clip-relative seconds. */
  t: number;
  /** Face-center x normalized to [0,1] of source width; null = no detection. */
  cx: number | null;
  /** Horizontal envelope of every visible face, normalized to source width. */
  left?: number | null;
  right?: number | null;
  /** Number of visible faces represented by the envelope. */
  faceCount?: number;
}

export interface CropKeyframe {
  t: number;
  /** Crop left edge in source pixels. */
  x: number;
}

export interface CropPlanningStats {
  totalShots: number;
  lockedShots: number;
  groupLockedShots: number;
  trackedShots: number;
  recoveryShots: number;
  centeredShots: number;
}

export interface CropPlanningResult {
  keyframes: CropKeyframe[];
  stats: CropPlanningStats;
}

/** Standard One Euro filter (1D). */
export class OneEuro {
  private prevT: number | null = null;
  private prevX = 0;
  private prevDx = 0;

  constructor(
    private minCutoff = 0.3,
    private beta = 0.007,
    private dCutoff = 1.0
  ) {}

  private alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(x: number, t: number): number {
    if (this.prevT === null) {
      this.prevT = t;
      this.prevX = x;
      return x;
    }
    const dt = Math.max(1e-3, t - this.prevT);
    const dx = (x - this.prevX) / dt;
    const aD = this.alpha(this.dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * this.prevDx;
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = this.alpha(cutoff, dt);
    const xHat = a * x + (1 - a) * this.prevX;
    this.prevT = t;
    this.prevX = xHat;
    this.prevDx = dxHat;
    return xHat;
  }
}

/** Hold briefly through detector flicker, then recover to source centre. */
export function fillGaps(samples: FaceSample[]): Array<{ t: number; cx: number }> {
  const firstValid = samples.find((s): s is FaceSample & { cx: number } => s.cx !== null);
  if (!firstValid) return [];
  let last: { t: number; cx: number } | null = null;
  return samples.map((s) => {
    if (s.cx !== null) {
      last = { t: s.t, cx: s.cx };
      return last;
    }
    return {
      t: s.t,
      cx: last
        ? (s.t - last.t <= LOST_HOLD_SEC ? last.cx : 0.5)
        : (firstValid.t - s.t <= LOST_HOLD_SEC ? firstValid.cx : 0.5),
    };
  });
}

function hasSustainedLoss(samples: FaceSample[]): boolean {
  let lastValidT: number | null = null;
  const firstValid = samples.find((s) => s.cx !== null);
  for (const sample of samples) {
    if (sample.cx !== null) {
      lastValidT = sample.t;
      continue;
    }
    const distance = lastValidT === null
      ? (firstValid ? firstValid.t - sample.t : Number.POSITIVE_INFINITY)
      : sample.t - lastValidT;
    if (distance > LOST_HOLD_SEC) return true;
  }
  return false;
}

/** Minimum face-detection coverage to trust tracking at all. */
const MIN_COVERAGE = 0.4;
/** Std below this fraction of width = "static" shot. */
const STATIC_STD = 0.04;
/** Dead zone: ignore moves smaller than this fraction of width. */
const DEAD_ZONE = 0.02;
/** Keep the last reliable subject through short detector flicker only. */
export const LOST_HOLD_SEC = 1.25;
/** Breathing room outside the union of visible face boxes. */
const FACE_ENVELOPE_MARGIN = 0.025;
/** Preserve intentional source centering when the ideal crop is already near it. */
const CENTER_SNAP_DISTANCE = 0.035;

export function planCropComposition(
  samples: FaceSample[],
  cuts: number[],
  srcW: number,
  srcH: number
): CropPlanningResult | null {
  const cropW = Math.floor((srcH * 9) / 16 / 2) * 2;
  if (cropW >= srcW || samples.length === 0) return null;
  const coverage = samples.filter((s) => s.cx !== null).length / samples.length;
  if (coverage < MIN_COVERAGE) return null;

  const cropFrac = cropW / srcW;
  const clampX = (cxNorm: number): number =>
    Math.round(Math.min(Math.max(cxNorm * srcW - cropW / 2, 0), srcW - cropW));

  // split samples into shot segments at the cut times
  const bounds = [...cuts].sort((a, b) => a - b);
  const segments: FaceSample[][] = [];
  let seg: FaceSample[] = [];
  let bi = 0;
  for (const s of samples) {
    while (bi < bounds.length && s.t >= bounds[bi]) {
      if (seg.length > 0) segments.push(seg);
      seg = [];
      bi++;
    }
    seg.push(s);
  }
  if (seg.length > 0) segments.push(seg);

  const stats: CropPlanningStats = {
    totalShots: 0,
    lockedShots: 0,
    groupLockedShots: 0,
    trackedShots: 0,
    recoveryShots: 0,
    centeredShots: 0,
  };
  const keyframes: CropKeyframe[] = [];
  for (const segment of segments) {
    stats.totalShots++;
    const segmentCoverage = segment.filter((s) => s.cx !== null).length / segment.length;
    if (segmentCoverage < MIN_COVERAGE) {
      keyframes.push({ t: segment[0].t, x: clampX(0.5) });
      stats.centeredShots++;
      continue;
    }
    const filled = fillGaps(segment);
    if (filled.length === 0) continue;

    const hasRecovery = hasSustainedLoss(segment);
    if (hasRecovery) stats.recoveryShots++;

    const visible = segment.filter((s) => s.cx !== null);
    const envelopeLeft = Math.min(...visible.map((s) => s.left ?? s.cx ?? 0.5));
    const envelopeRight = Math.max(...visible.map((s) => s.right ?? s.cx ?? 0.5));
    const envelopeWidth = envelopeRight - envelopeLeft + FACE_ENVELOPE_MARGIN * 2;
    const hasGroup = visible.some((s) => (s.faceCount ?? 1) > 1);

    // Comfort-first composition: if every observed face position fits in one
    // crop, lock the virtual camera for the entire shot. This prevents small
    // body movement and multi-person turn-taking from creating artificial pan.
    if (!hasRecovery && envelopeWidth <= cropFrac) {
      let center = (envelopeLeft + envelopeRight) / 2;
      if (Math.abs(center - 0.5) <= CENTER_SNAP_DISTANCE) center = 0.5;
      keyframes.push({ t: filled[0].t, x: clampX(center) });
      stats.lockedShots++;
      if (hasGroup) stats.groupLockedShots++;
      continue;
    }

    const xs = filled.map((f) => f.cx);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const std = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
    const median = [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

    if (std < STATIC_STD) {
      keyframes.push({ t: filled[0].t, x: clampX(median) });
      stats.lockedShots++;
    } else {
      stats.trackedShots++;
      const drift = xs[xs.length - 1] - xs[0];
      if (!hasRecovery && Math.abs(drift) > 2 * std) {
        const steps = Math.min(12, filled.length);
        for (let i = 0; i < steps; i++) {
          const f = filled[Math.floor((i * (filled.length - 1)) / Math.max(1, steps - 1))];
          keyframes.push({ t: f.t, x: clampX(xs[0] + (drift * i) / Math.max(1, steps - 1)) });
        }
      } else {
        const euro = new OneEuro();
        let lastX: number | null = null;
        for (const f of filled) {
          const smoothed = euro.filter(f.cx, f.t);
          if (lastX === null || Math.abs(smoothed - lastX) > DEAD_ZONE) {
            keyframes.push({ t: f.t, x: clampX(smoothed) });
            lastX = smoothed;
          }
        }
      }
    }
  }
  if (keyframes.length === 0) return null;
  keyframes.sort((a, b) => a.t - b.t);
  const out: CropKeyframe[] = [];
  for (const k of keyframes) {
    const last = out[out.length - 1];
    if (last && k.x === last.x) continue;
    out.push(k);
  }
  return { keyframes: out, stats };
}

export function planCropTrack(
  samples: FaceSample[],
  cuts: number[],
  srcW: number,
  srcH: number
): CropKeyframe[] | null {
  return planCropComposition(samples, cuts, srcW, srcH)?.keyframes ?? null;
}

/** Render keyframes as an ffmpeg sendcmd file targeting `crop@track`. */
export function renderSendcmd(keyframes: CropKeyframe[]): string {
  return keyframes.map((k) => `${Math.max(0, k.t).toFixed(3)} crop@track x ${k.x};`).join("\n") + "\n";
}

/** Even keyframe downsampling (keeps first & last). */
export function downsampleKeyframes(kfs: CropKeyframe[], max: number): CropKeyframe[] {
  if (kfs.length <= max) return kfs;
  const out: CropKeyframe[] = [];
  for (let i = 0; i < max; i++) {
    out.push(kfs[Math.round((i * (kfs.length - 1)) / (max - 1))]);
  }
  return out;
}

/**
 * Render keyframes as a piecewise-linear crop-x expression in `t`.
 * The bundled ffmpeg's crop filter ignores runtime commands (verified), but
 * its x option re-evaluates per frame — so we compile the whole track into
 * one expression. Nested ifs stay shallow via keyframe downsampling.
 */
export function renderCropXExpr(keyframes: CropKeyframe[], maxKeyframes = 32): string {
  const kfs = downsampleKeyframes(keyframes, maxKeyframes).filter(
    (k, i, arr) => i === 0 || k.t > arr[i - 1].t + 1e-4
  );
  if (kfs.length === 0) return "0";
  if (kfs.length === 1) return String(kfs[0].x);
  let expr = String(kfs[kfs.length - 1].x);
  for (let i = kfs.length - 2; i >= 0; i--) {
    const a = kfs[i];
    const b = kfs[i + 1];
    const dt = (b.t - a.t).toFixed(4);
    const seg = `${a.x}+${b.x - a.x}*(t-${a.t.toFixed(3)})/${dt}`;
    expr = `if(lt(t,${b.t.toFixed(3)}),${seg},${expr})`;
  }
  return `if(lt(t,${kfs[0].t.toFixed(3)}),${kfs[0].x},${expr})`;
}
