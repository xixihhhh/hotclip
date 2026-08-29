import { describe, it, expect } from "vitest";
import {
  LOST_HOLD_SEC,
  OneEuro,
  cropXAtTime,
  downsampleKeyframes,
  evaluateCropCoverage,
  fillGaps,
  planCropComposition,
  planCropTrack,
  renderSendcmd,
  renderCropXExpr,
  type FaceSample,
} from "../reframe/track";
import { mapToOutputTime, remapCropKeyframes } from "../reframe";
import { decodeYunet, pickMainFace, YUNET_INPUT, type FaceBox } from "../reframe/yunet";

function samplesOf(cxs: Array<number | null>, fps = 3): FaceSample[] {
  return cxs.map((cx, i) => ({ t: i / fps, cx }));
}

describe("planCropTrack modes", () => {
  const W = 1920;
  const H = 1080; // cropW = 606 → even 606? 1080*9/16=607.5 → floor/2*2 = 606

  it("static shot → single keyframe at the median", () => {
    const kfs = planCropTrack(samplesOf([0.5, 0.51, 0.5, 0.49, 0.5, 0.5]), [], W, H);
    expect(kfs).toHaveLength(1);
    const cropW = Math.floor((H * 9) / 16 / 2) * 2;
    expect(kfs![0].x).toBe(Math.round(0.5 * W - cropW / 2));
  });

  it("locks a moving subject when its full shot envelope fits safely", () => {
    const samples = samplesOf([0.4, 0.43, 0.48, 0.53, 0.57]);
    const planned = planCropComposition(samples, [], W, H)!;
    expect(planned.keyframes).toHaveLength(1);
    expect(planned.stats).toMatchObject({ lockedShots: 1, trackedShots: 0 });
  });

  it("locks a group envelope and snaps a near-centred composition to centre", () => {
    const samples: FaceSample[] = [0, 1 / 3, 2 / 3, 1].map((t) => ({
      t,
      cx: 0.42,
      left: 0.36,
      right: 0.6,
      faceCount: 2,
    }));
    const planned = planCropComposition(samples, [], W, H)!;
    const cropW = Math.floor((H * 9) / 16 / 2) * 2;
    expect(planned.keyframes).toEqual([{ t: 0, x: Math.round(W / 2 - cropW / 2), hold: true }]);
    expect(planned.stats).toMatchObject({ lockedShots: 1, groupLockedShots: 1 });
  });

  it("returns toward centre after a sustained detection loss", () => {
    const samples: FaceSample[] = [];
    for (let i = 0; i < 5; i++) samples.push({ t: i / 3, cx: 0.25 });
    for (let i = 5; i < 11; i++) samples.push({ t: i / 3, cx: null });
    const filled = fillGaps(samples);
    expect(filled[5].cx).toBe(0.25);
    expect(filled.find((sample) => sample.t - 4 / 3 > LOST_HOLD_SEC)?.cx).toBe(0.5);
    const planned = planCropComposition(samples, [], W, H)!;
    expect(planned.stats.recoveryShots).toBe(1);
    expect(planned.keyframes.length).toBeGreaterThan(1);
    expect(planned.keyframes.at(-1)!.x).toBeGreaterThan(planned.keyframes[0].x);
  });

  it("steady drift → interpolated pan keyframes", () => {
    const kfs = planCropTrack(samplesOf([0.3, 0.34, 0.38, 0.42, 0.46, 0.5, 0.54, 0.58]), [], W, H);
    expect(kfs!.length).toBeGreaterThan(2);
    // monoton increasing x
    for (let i = 1; i < kfs!.length; i++) expect(kfs![i].x).toBeGreaterThanOrEqual(kfs![i - 1].x);
  });

  it("low face coverage → null (center fallback)", () => {
    expect(planCropTrack(samplesOf([0.5, null, null, null, null, null]), [], W, H)).toBeNull();
  });

  it("source narrower than 9:16 → null", () => {
    expect(planCropTrack(samplesOf([0.5, 0.5, 0.5]), [], 500, 1080)).toBeNull();
  });

  it("scene cuts split segments (independent modes per shot)", () => {
    // shot A static at 0.3; cut at t=1.0; shot B static at 0.7
    const samples = [
      ...samplesOf([0.3, 0.3, 0.3]),
      { t: 1.0, cx: 0.7 },
      { t: 1.33, cx: 0.7 },
      { t: 1.67, cx: 0.7 },
    ];
    const kfs = planCropTrack(samples, [1.0], W, H)!;
    expect(kfs).toHaveLength(2);
    expect(kfs[1].x).toBeGreaterThan(kfs[0].x);
  });

  it("centres a sparse face-free shot instead of holding the previous crop", () => {
    const samples = [
      ...samplesOf([0.25, 0.25, 0.25]),
      { t: 1, cx: null },
      { t: 4 / 3, cx: null },
      { t: 5 / 3, cx: null },
    ];
    const planned = planCropComposition(samples, [1], W, H)!;
    const cropW = Math.floor((H * 9) / 16 / 2) * 2;
    expect(planned.keyframes.at(-1)).toEqual({ t: 1, x: Math.round(W / 2 - cropW / 2), hold: true });
    expect(planned.stats).toMatchObject({ totalShots: 2, centeredShots: 1 });
  });

  it("x is clamped inside the source", () => {
    const kfs = planCropTrack(samplesOf([0.01, 0.01, 0.99, 0.99, 0.99, 0.01]), [], W, H)!;
    const cropW = Math.floor((H * 9) / 16 / 2) * 2;
    for (const k of kfs) {
      expect(k.x).toBeGreaterThanOrEqual(0);
      expect(k.x).toBeLessThanOrEqual(W - cropW);
    }
  });
});

describe("crop trajectory / subject coverage", () => {
  it("holds a locked shot until the next cut instead of drifting across it", () => {
    const keyframes = [
      { t: 0, x: 100, hold: true },
      { t: 2, x: 500, hold: true },
    ];
    expect(cropXAtTime(keyframes, 1.9)).toBe(100);
    expect(cropXAtTime(keyframes, 2)).toBe(500);
    expect(renderCropXExpr(keyframes)).toContain("if(lt(t,2.000),100,500)");
  });

  it("keeps linear motion inside a tracking shot then holds its tail", () => {
    const keyframes = [
      { t: 0, x: 100 },
      { t: 1, x: 300, hold: true },
      { t: 3, x: 700, hold: true },
    ];
    expect(cropXAtTime(keyframes, 0.5)).toBe(200);
    expect(cropXAtTime(keyframes, 2.5)).toBe(300);
  });

  it("reports the least-visible face per sampled frame", () => {
    const samples: FaceSample[] = [
      { t: 0, cx: 0.3, faces: [{ left: 0.25, right: 0.35 }] },
      { t: 1, cx: 0.5, faces: [{ left: 0.45, right: 0.6 }] },
    ];
    const coverage = evaluateCropCoverage(samples, [{ t: 0, x: 200, hold: true }], 1000, 300);
    expect(coverage[0].minVisibleFraction).toBe(1);
    expect(coverage[1].minVisibleFraction).toBeCloseTo(1 / 3, 3);
  });

  it("keeps every shot boundary even when it exceeds the soft keyframe limit", () => {
    const keyframes = Array.from({ length: 40 }, (_, i) => ({ t: i, x: i * 10, hold: true }));
    expect(downsampleKeyframes(keyframes, 8)).toEqual(keyframes);
  });

  it("does not interpolate crop motion through a removed jump-cut gap", () => {
    const source = [
      { t: 0, x: 0 },
      { t: 10, x: 1000, hold: true },
    ];
    const mapped = remapCropKeyframes(source, [
      { startSec: 100, endSec: 102 },
      { startSec: 108, endSec: 110 },
    ], 100);
    expect(cropXAtTime(mapped, 1)).toBeCloseTo(100, 3);
    expect(cropXAtTime(mapped, 2)).toBeCloseTo(800, 3);
    expect(cropXAtTime(mapped, 3)).toBeCloseTo(900, 3);
  });
});

describe("OneEuro / fillGaps", () => {
  it("smooths jitter but follows real movement", () => {
    const euro = new OneEuro();
    let out = 0;
    // jittery around 0.5
    for (let i = 0; i < 20; i++) out = euro.filter(0.5 + (i % 2 === 0 ? 0.01 : -0.01), i / 3);
    expect(Math.abs(out - 0.5)).toBeLessThan(0.01);
  });

  it("fills detection gaps from the nearest valid sample", () => {
    const filled = fillGaps(samplesOf([0.3, null, 0.6]));
    expect(filled[1].cx).toBeCloseTo(0.3, 5); // nearest by time (t=0.33 vs t=0.67)
  });
});

describe("renderSendcmd", () => {
  it("targets crop@track and clamps negative times", () => {
    const cmd = renderSendcmd([
      { t: -0.01, x: 100 },
      { t: 1.5, x: 240 },
    ]);
    expect(cmd).toBe("0.000 crop@track x 100;\n1.500 crop@track x 240;\n");
  });
});

describe("mapToOutputTime", () => {
  const segments = [
    { startSec: 10, endSec: 12 },
    { startSec: 14, endSec: 16 },
  ];

  it("maps kept times and drops spliced-out ones", () => {
    expect(mapToOutputTime(0.5, segments, 10)).toBeCloseTo(0.5, 5); // 10.5 abs
    expect(mapToOutputTime(3, segments, 10)).toBeNull(); // 13 abs — cut out
    expect(mapToOutputTime(5, segments, 10)).toBeCloseTo(3, 5); // 15 abs → 2 + 1
  });
});

describe("decodeYunet", () => {
  it("decodes a synthetic single-anchor hit with sqrt scoring and exp size", () => {
    const fw = YUNET_INPUT / 32;
    const n = fw * fw;
    const cls = new Float32Array(n);
    const obj = new Float32Array(n);
    const bbox = new Float32Array(n * 4);
    const idx = 5 * fw + 8; // row 5, col 8
    cls[idx] = 0.81;
    obj[idx] = 1.0;
    bbox[idx * 4] = 0.5; // dx
    bbox[idx * 4 + 1] = 0.5;
    bbox[idx * 4 + 2] = Math.log(4); // w = 4*32
    bbox[idx * 4 + 3] = Math.log(4);
    const empty8 = { data: new Float32Array(0) };
    const boxes = decodeYunet({
      cls_8: empty8, obj_8: empty8, bbox_8: empty8,
      cls_16: empty8, obj_16: empty8, bbox_16: empty8,
      cls_32: { data: cls }, obj_32: { data: obj }, bbox_32: { data: bbox },
    });
    expect(boxes).toHaveLength(1);
    expect(boxes[0].score).toBeCloseTo(0.9, 5);
    expect(boxes[0].w).toBeCloseTo(128, 3);
    expect(boxes[0].x).toBeCloseTo((8 + 0.5) * 32 - 64, 3);
  });
});

describe("pickMainFace continuity", () => {
  const box = (x: number, size: number): FaceBox => ({ x, y: 100, w: size, h: size, score: 0.9 });

  it("sticks with the tracked face even when a bigger one appears", () => {
    const prev = box(100, 100);
    const picked = pickMainFace([box(105, 100), box(400, 130)], prev);
    expect(picked!.x).toBe(105); // continuity beats area
  });

  it("switches to the biggest face when the track is lost", () => {
    const prev = box(100, 100);
    const picked = pickMainFace([box(400, 130), box(600, 90)], prev);
    expect(picked!.x).toBe(400);
  });

  it("no previous → biggest face; empty → null", () => {
    expect(pickMainFace([box(50, 80), box(300, 120)], null)!.x).toBe(300);
    expect(pickMainFace([], null)).toBeNull();
  });
});
