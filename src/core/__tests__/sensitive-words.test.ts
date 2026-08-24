import { describe, expect, it } from "vitest";
import { findSensitiveRanges, mapSensitiveRanges, sanitizeSensitiveWords } from "../sensitive-words";
import { buildCutArgs, buildJumpCutArgs } from "../cut";
import { audiogramSpec, buildAudiogramArgs } from "../audiogram";

describe("sensitive word timing", () => {
  it("matches a CJK phrase across character tokens", () => {
    const words = [..."你这个傻逼"].map((text, i) => ({ text, startSec: i, endSec: i + 0.8 }));
    expect(findSensitiveRanges(words, ["傻逼"], 0)).toEqual([{ startSec: 3, endSec: 4.8 }]);
  });

  it("matches Latin whole words case-insensitively without touching substrings", () => {
    const words = [
      { text: "SHIT", startSec: 1, endSec: 1.5 }, { text: "shipment", startSec: 2, endSec: 2.8 },
    ];
    expect(findSensitiveRanges(words, ["shit"], 0)).toEqual([{ startSec: 1, endSec: 1.5 }]);
  });

  it("maps source timing through multi-piece output and merges padding", () => {
    const words = [{ text: "妈的", startSec: 11, endSec: 12 }, { text: "shit", startSec: 31, endSec: 32 }];
    const ranges = mapSensitiveRanges(words, ["妈的", "shit"], [{ startSec: 10, endSec: 15 }, { startSec: 30, endSec: 35 }]);
    expect(ranges[0].startSec).toBeCloseTo(0.94);
    expect(ranges[0].endSec).toBeCloseTo(2.06);
    expect(ranges[1].startSec).toBeCloseTo(5.94);
    expect(ranges[1].endSec).toBeCloseTo(7.06);
  });

  it("sanitizes, deduplicates and bounds custom terms", () => {
    expect(sanitizeSensitiveWords([" shit ", "shit", "", 3])).toEqual(["shit"]);
  });

  it("injects mute windows into single, jump-cut and audiogram audio graphs", () => {
    const muteRanges = [{ startSec: 1, endSec: 1.5 }];
    const single = buildCutArgs("in.mp4", "out.mp4", 10, 15, { muteRanges });
    expect(single[single.indexOf("-af") + 1]).toContain("between(t,1.000,1.500)");
    const jump = buildJumpCutArgs("in.mp4", "out.mp4", 10, [{ startSec: 10, endSec: 12 }, { startSec: 14, endSec: 16 }], { muteRanges });
    expect(jump[jump.indexOf("-filter_complex") + 1]).toContain("between(t,1.000,1.500)");
    const audio = buildAudiogramArgs("in.mp3", "out.mp4", [{ startSec: 10, endSec: 15 }], { spec: audiogramSpec(true), muteRanges });
    expect(audio[audio.indexOf("-filter_complex") + 1]).toContain("between(t,1.000,1.500)");
  });
});
