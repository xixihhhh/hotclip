import { describe, it, expect } from "vitest";
import { computeJumpCut, mergeShortCuts } from "../gaps";
import { buildJumpCutArgs } from "../cut";
import type { PeakTrack } from "../audio-peaks";
import type { TranscriptWord } from "../../shared/api-types";

function w(text: string, startSec: number, endSec: number): TranscriptWord {
  return { text, startSec, endSec };
}

describe("computeJumpCut", () => {
  // speech 10-12s, 2s silence, speech 14-16s
  const words = [w("前", 10, 11), w("半", 11, 12), w("后", 14, 15), w("半", 15, 16)];

  it("cuts the silence into two kept segments with padding", () => {
    const plan = computeJumpCut(words, 10, 16.5);
    expect(plan.segments).toHaveLength(2);
    const [a, b] = plan.segments;
    expect(a.startSec).toBeCloseTo(10, 2); // clamped by clip start (10 - 0.15 lead-in)
    expect(a.endSec).toBeCloseTo(12.18, 2); // + pad after
    expect(b.startSec).toBeCloseTo(13.88, 2); // - pad before
    expect(b.endSec).toBeCloseTo(16.3, 2); // + tail
    expect(plan.removedSec).toBeCloseTo(6.5 - plan.durationSec, 5);
    expect(plan.removedSec).toBeGreaterThan(1.4);
  });

  it("remaps words onto the compressed output timeline", () => {
    const plan = computeJumpCut(words, 10, 16.5);
    const [, , w3] = plan.words;
    // third word starts at seg2 start → output time = seg1 duration + pad-before offset
    const seg1Dur = plan.segments[0].endSec - plan.segments[0].startSec;
    expect(w3.startSec).toBeCloseTo(seg1Dur + (14 - plan.segments[1].startSec), 3);
    // monotonic and starting near zero
    expect(plan.words[0].startSec).toBeCloseTo(0, 2);
    for (let i = 1; i < plan.words.length; i++) {
      expect(plan.words[i].startSec).toBeGreaterThanOrEqual(plan.words[i - 1].startSec);
    }
  });

  it("no gaps → single segment trimmed to speech bounds", () => {
    const tight = [w("a", 10.5, 11), w("b", 11.1, 12)];
    const plan = computeJumpCut(tight, 10, 20);
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0].startSec).toBeCloseTo(10.35, 2); // lead-in pad
    expect(plan.segments[0].endSec).toBeCloseTo(12.3, 2); // tail pad
  });

  it("no words → keeps the full clip", () => {
    const plan = computeJumpCut([], 5, 10);
    expect(plan.segments).toEqual([{ startSec: 5, endSec: 10 }]);
    expect(plan.durationSec).toBe(5);
  });

  // peaks: 30 blocks/s track covering 10-16.5s, quiet everywhere by default
  function trackWithBurst(burstFrom?: number, burstTo?: number): PeakTrack {
    const hopSec = 1 / 30;
    const values = new Float32Array(Math.ceil(6.5 / hopSec)).fill(0.01);
    if (burstFrom !== undefined && burstTo !== undefined) {
      for (let i = Math.floor((burstFrom - 10) / hopSec); i * hopSec + 10 < burstTo; i++) {
        values[i] = 0.4;
      }
    }
    return { values, startSec: 10, hopSec };
  }

  it("AND gate: quiet gap still gets cut when peaks are provided", () => {
    const plan = computeJumpCut(words, 10, 16.5, { peaks: trackWithBurst() });
    expect(plan.segments).toHaveLength(2);
  });

  it("AND gate: loud wordless gap (laughter/applause) survives the cut", () => {
    const plan = computeJumpCut(words, 10, 16.5, { peaks: trackWithBurst(12.5, 13.5) });
    expect(plan.segments).toHaveLength(1);
    expect(plan.removedSec).toBeLessThan(0.5);
  });
});

describe("mergeShortCuts", () => {
  it("fills back splices shorter than the minimum cut", () => {
    const merged = mergeShortCuts(
      [
        { startSec: 0, endSec: 2 },
        { startSec: 2.1, endSec: 4 }, // 0.1s cut — churn
        { startSec: 5, endSec: 6 }, // 1s cut — real
      ],
      0.2
    );
    expect(merged).toEqual([
      { startSec: 0, endSec: 4 },
      { startSec: 5, endSec: 6 },
    ]);
  });

  it("passes through when nothing is short", () => {
    const segs = [
      { startSec: 0, endSec: 2 },
      { startSec: 3, endSec: 4 },
    ];
    expect(mergeShortCuts(segs, 0.2)).toEqual(segs);
  });
});

describe("buildJumpCutArgs", () => {
  const segments = [
    { startSec: 10, endSec: 12.2 },
    { startSec: 13.9, endSec: 16.3 },
  ];

  it("seeks to clip start and trims with seek-relative times", () => {
    const args = buildJumpCutArgs("/v/in.mp4", "/v/out.mp4", 10, segments);
    expect(args[args.indexOf("-ss") + 1]).toBe("00:00:10.000");
    const fc = args[args.indexOf("-filter_complex") + 1];
    expect(fc).toContain("[0:v]trim=start=0.000:end=2.200");
    expect(fc).toContain("[0:a]atrim=start=3.900:end=6.300");
    expect(fc).toContain("concat=n=2:v=1:a=1");
    expect(args).toContain("[vout]");
    expect(args).toContain("[aout]");
  });

  it("chains reframe + subtitles after the concat", () => {
    const args = buildJumpCutArgs("/v/in.mp4", "/v/out.mp4", 10, segments, {
      vertical: true,
      subtitlePath: "/tmp/a.ass",
    });
    const fc = args[args.indexOf("-filter_complex") + 1];
    expect(fc).toMatch(/\[vc\]crop=.*scale=1080:1920.*subtitles=filename='\/tmp\/a\.ass'\[vout\]/);
  });
});
