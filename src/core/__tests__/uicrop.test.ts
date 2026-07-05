import { describe, it, expect } from "vitest";
import { detectStaticBands } from "../uicrop";
import { buildVideoFilters } from "../cut";

/** Synthesize frames: static top/bottom bands, noisy middle. */
function makeFrames(count: number, w: number, h: number, topRows: number, bottomRows: number): Uint8Array[] {
  const frames: Uint8Array[] = [];
  for (let f = 0; f < count; f++) {
    const buf = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const isStatic = y < topRows || y >= h - bottomRows;
        // static chrome: constant value; content: strongly frame-dependent
        buf[y * w + x] = isStatic ? 40 : (f * 53 + x * 7 + y * 13) % 256;
      }
    }
    frames.push(buf);
  }
  return frames;
}

describe("detectStaticBands", () => {
  it("finds top/bottom static bands as height fractions", () => {
    const { topFrac, bottomFrac } = detectStaticBands(makeFrames(8, 32, 100, 10, 20), 32, 100);
    expect(topFrac).toBeCloseTo(0.1, 2);
    expect(bottomFrac).toBeCloseTo(0.2, 2);
  });

  it("returns zero crop for full-motion content", () => {
    const { topFrac, bottomFrac } = detectStaticBands(makeFrames(8, 32, 100, 0, 0), 32, 100);
    expect(topFrac).toBe(0);
    expect(bottomFrac).toBe(0);
  });

  it("caps runaway bands and ignores hairline bands", () => {
    const capped = detectStaticBands(makeFrames(8, 32, 100, 40, 50), 32, 100);
    expect(capped.topFrac).toBeLessThanOrEqual(0.25);
    expect(capped.bottomFrac).toBeLessThanOrEqual(0.32);
    const hairline = detectStaticBands(makeFrames(8, 32, 100, 1, 1), 32, 100);
    expect(hairline.topFrac).toBe(0);
    expect(hairline.bottomFrac).toBe(0);
  });

  it("needs at least 3 frames", () => {
    expect(detectStaticBands(makeFrames(2, 32, 100, 10, 10), 32, 100)).toEqual({ topFrac: 0, bottomFrac: 0 });
  });
});

describe("buildVideoFilters uiCrop", () => {
  it("crops the chrome BEFORE the vertical reframe", () => {
    const vf = buildVideoFilters({ uiCrop: { topFrac: 0.08, bottomFrac: 0.2 }, vertical: true });
    expect(vf[0]).toContain("crop=w=iw:h='floor(ih*0.7200/2)*2'");
    expect(vf[0]).toContain("y='floor(ih*0.0800/2)*2'");
    expect(vf[1]).toContain("crop=w='min(iw,ih*9/16)'");
  });

  it("zero crop → no ui filter", () => {
    const vf = buildVideoFilters({ uiCrop: { topFrac: 0, bottomFrac: 0 }, vertical: true });
    expect(vf[0]).toContain("min(iw,ih*9/16)");
  });
});
