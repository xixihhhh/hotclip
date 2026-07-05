import { describe, expect, it } from "vitest";
import { peaksFromPcm, peakInRange, type PeakTrack } from "../audio-peaks";

describe("peaksFromPcm", () => {
  it("folds each block to its max |sample| normalised to 0..1", () => {
    const pcm = new Int16Array([0, 100, -3277, 50, 0, 0, 16384, -20, 0, 0]);
    const peaks = peaksFromPcm(pcm, 5);
    expect(peaks.length).toBe(2);
    expect(peaks[0]).toBeCloseTo(3277 / 32768, 5);
    expect(peaks[1]).toBeCloseTo(16384 / 32768, 5);
  });

  it("keeps fractional block boundaries aligned via error accumulation", () => {
    // 16000 Hz at 30 blocks/s -> 533.33 samples per block; over 3s the block
    // count must be exact (90), not drift to 89 or 91.
    const pcm = new Int16Array(16000 * 3);
    const peaks = peaksFromPcm(pcm, 16000 / 30);
    expect(peaks.length).toBe(90);
  });

  it("handles empty input", () => {
    expect(peaksFromPcm(new Int16Array(0), 5).length).toBe(0);
  });
});

describe("peakInRange", () => {
  const track: PeakTrack = {
    values: Float32Array.from([0.01, 0.02, 0.5, 0.02, 0.01]),
    startSec: 10,
    hopSec: 1,
  };

  it("returns the max peak inside the window", () => {
    expect(peakInRange(track, 11.5, 13.5)).toBeCloseTo(0.5);
  });

  it("stays quiet when the window avoids the burst", () => {
    expect(peakInRange(track, 10, 10.9)).toBeLessThan(0.05);
  });

  it("returns 0 (no evidence) for windows fully outside the track", () => {
    expect(peakInRange(track, 0, 5)).toBe(0);
    expect(peakInRange(track, 100, 200)).toBe(0);
  });

  it("clamps partially overlapping windows to the track bounds", () => {
    expect(peakInRange(track, 8, 10.5)).toBeCloseTo(0.02, 4); // start clamp; ceil reaches block 1
    expect(peakInRange(track, 14.5, 100)).toBeCloseTo(0.01, 4); // end clamp
  });
});
