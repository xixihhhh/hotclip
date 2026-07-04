import { describe, it, expect } from "vitest";
import { parseProbeOutput, parseFrameRate } from "../probe";
import { toUnpackedPath } from "../binaries";

describe("parseFrameRate", () => {
  it("parses N/D rationals", () => {
    expect(parseFrameRate("30000/1001")).toBeCloseTo(29.97, 2);
    expect(parseFrameRate("25/1")).toBe(25);
  });

  it("handles plain numbers and bad input", () => {
    expect(parseFrameRate("30")).toBe(30);
    expect(parseFrameRate("0/0")).toBe(0);
    expect(parseFrameRate(undefined)).toBe(0);
    expect(parseFrameRate("abc")).toBe(0);
  });
});

describe("parseProbeOutput", () => {
  const typical = {
    streams: [
      { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30000/1001" },
      { codec_type: "audio", codec_name: "aac" },
    ],
    format: { duration: "7205.34", bit_rate: "4500000" },
  };

  it("normalizes a typical mp4", () => {
    const info = parseProbeOutput(typical);
    expect(info.durationSec).toBeCloseTo(7205.34, 2);
    expect(info.hasVideo).toBe(true);
    expect(info.hasAudio).toBe(true);
    expect(info.width).toBe(1920);
    expect(info.height).toBe(1080);
    expect(info.fps).toBeCloseTo(29.97, 2);
    expect(info.videoCodec).toBe("h264");
    expect(info.audioCodec).toBe("aac");
    expect(info.bitRate).toBe(4500000);
  });

  it("supports audio-only input (podcasts)", () => {
    const info = parseProbeOutput({
      streams: [{ codec_type: "audio", codec_name: "mp3", duration: "3600.5" }],
      format: {},
    });
    expect(info.hasVideo).toBe(false);
    expect(info.hasAudio).toBe(true);
    expect(info.durationSec).toBeCloseTo(3600.5, 1);
    expect(info.width).toBe(0);
  });

  it("falls back to stream duration when the container lacks one", () => {
    const info = parseProbeOutput({
      streams: [
        { codec_type: "video", codec_name: "vp9", width: 1280, height: 720, duration: "120.0" },
      ],
    });
    expect(info.durationSec).toBe(120);
  });

  it("never throws on hostile/empty input", () => {
    expect(parseProbeOutput(null).durationSec).toBe(0);
    expect(parseProbeOutput({}).hasVideo).toBe(false);
    expect(parseProbeOutput({ streams: "nope", format: 42 }).durationSec).toBe(0);
  });
});

describe("toUnpackedPath", () => {
  it("rewrites asar paths to unpacked", () => {
    expect(toUnpackedPath("/Applications/HotClip.app/Contents/Resources/app.asar/node_modules/ffmpeg-static/ffmpeg")).toBe(
      "/Applications/HotClip.app/Contents/Resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg"
    );
    expect(toUnpackedPath("C:\\app\\resources\\app.asar\\bin\\ffprobe.exe")).toBe(
      "C:\\app\\resources\\app.asar.unpacked\\bin\\ffprobe.exe"
    );
  });

  it("is a no-op outside asar", () => {
    expect(toUnpackedPath("/usr/local/bin/ffmpeg")).toBe("/usr/local/bin/ffmpeg");
  });
});
