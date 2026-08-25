import { describe, expect, it } from "vitest";
import { canCopyVideoStream, isKeyframeAligned, keyframeToleranceSec, parseKeyframeTimestamps } from "../smart-render";
import type { MediaInfo } from "../probe";

const media: MediaInfo = {
  durationSec: 120,
  hasVideo: true,
  hasAudio: true,
  width: 1920,
  height: 1080,
  fps: 25,
  bitRate: 4_000_000,
  videoCodec: "h264",
  audioCodec: "aac",
};

describe("keyframe parsing and alignment", () => {
  it("normalizes alternate ffprobe timestamp fields", () => {
    expect(parseKeyframeTimestamps({
      frames: [
        { pkt_pts_time: "5.000" },
        { best_effort_timestamp_time: "1.000" },
        { pts_time: "bad" },
      ],
    })).toEqual([1, 5]);
  });

  it("uses a half-frame tolerance with a conservative floor", () => {
    expect(keyframeToleranceSec(25)).toBe(0.02);
    expect(keyframeToleranceSec(60)).toBe(0.015);
    expect(isKeyframeAligned(10, 25, [9.981])).toBe(true);
    expect(isKeyframeAligned(10, 25, [9.95])).toBe(false);
    expect(isKeyframeAligned(0, 0, [])).toBe(true);
  });
});

describe("smart video-copy eligibility", () => {
  it("accepts only H.264 at a proven keyframe with no video filters", () => {
    expect(canCopyVideoStream(media, 10, {}, [10])).toBe(true);
    expect(canCopyVideoStream({ ...media, videoCodec: "hevc" }, 10, {}, [10])).toBe(false);
    expect(canCopyVideoStream(media, 10.1, {}, [10])).toBe(false);
    expect(canCopyVideoStream(media, 10, { vertical: true }, [10])).toBe(false);
    expect(canCopyVideoStream(media, 10, { watermark: { path: "logo.png", corner: "top-right", opacity: 1, widthPx: 200 } }, [10])).toBe(false);
  });

  it("allows audio-only processing because audio is still encoded", () => {
    expect(canCopyVideoStream(media, 10, {
      denoise: true,
      normalizeLoudness: true,
      muteRanges: [{ startSec: 1, endSec: 2 }],
    }, [10])).toBe(true);
  });
});
