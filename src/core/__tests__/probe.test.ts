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
    expect(info.videoStreamIndex).toBe(0);
    expect(info.audioCodec).toBe("aac");
    expect(info.audioStreamIndex).toBe(1);
    expect(info.bitRate).toBe(4500000);
    expect(info.pixelFormat).toBe("");
    expect(info.bitDepth).toBe(0);
    expect(info.colorPrimaries).toBe("");
    expect(info.colorTransfer).toBe("");
    expect(info.colorSpace).toBe("");
    expect(info.colorRange).toBe("");
    expect(info.hdrPeakNits).toBe(0);
  });

  it("normalizes HDR stream metadata and derives omitted bit depth from pix_fmt", () => {
    const info = parseProbeOutput({
      streams: [{
        codec_type: "video",
        codec_name: "hevc",
        width: 3840,
        height: 2160,
        avg_frame_rate: "60/1",
        pix_fmt: "yuv420p10le",
        color_primaries: "bt2020",
        color_transfer: "smpte2084",
        color_space: "bt2020nc",
        color_range: "tv",
        side_data_list: [
          { side_data_type: "Mastering display metadata", max_luminance: "10000000/10000" },
          { side_data_type: "Content light level metadata", max_content: 2000 },
        ],
      }],
    });

    expect(info.pixelFormat).toBe("yuv420p10le");
    expect(info.bitDepth).toBe(10);
    expect(info.colorPrimaries).toBe("bt2020");
    expect(info.colorTransfer).toBe("smpte2084");
    expect(info.colorSpace).toBe("bt2020nc");
    expect(info.colorRange).toBe("tv");
    expect(info.hdrPeakNits).toBe(2000);
  });

  it("selects the non-attached default video by global index and reads color from that exact stream", () => {
    const info = parseProbeOutput({
      streams: [
        {
          index: 4,
          codec_type: "video",
          codec_name: "mjpeg",
          width: 1200,
          height: 1200,
          color_transfer: "bt709",
          disposition: { default: 1, attached_pic: 1 },
        },
        {
          index: 7,
          codec_type: "video",
          codec_name: "h264",
          width: 1280,
          height: 720,
          color_transfer: "bt709",
          disposition: { default: 0, attached_pic: 0 },
        },
        {
          index: 9,
          codec_type: "video",
          codec_name: "hevc",
          width: 1920,
          height: 1080,
          pix_fmt: "yuv420p10le",
          color_primaries: "bt2020",
          color_transfer: "smpte2084",
          color_space: "bt2020nc",
          color_range: "tv",
          disposition: { default: 1, attached_pic: 0 },
          side_data_list: [{ max_content: 2000 }],
        },
        { index: 11, codec_type: "audio", codec_name: "aac", disposition: { default: 1 } },
      ],
    });

    expect(info).toMatchObject({
      videoStreamIndex: 9,
      audioStreamIndex: 11,
      videoCodec: "hevc",
      width: 1920,
      colorTransfer: "smpte2084",
      hdrPeakNits: 2000,
    });
  });

  it("uses resolution then input order as a stable fallback when no playable video is default", () => {
    const info = parseProbeOutput({
      streams: [
        { index: 3, codec_type: "video", codec_name: "h264", width: 640, height: 360 },
        { index: 8, codec_type: "video", codec_name: "hevc", width: 1920, height: 1080 },
        { index: 10, codec_type: "video", codec_name: "vp9", width: 1920, height: 1080 },
      ],
    });
    expect(info.videoStreamIndex).toBe(8);
    expect(info.videoCodec).toBe("hevc");
  });

  it("falls back to mastering peak, clamps hostile values, and ignores invalid ratios", () => {
    const mastered = parseProbeOutput({
      streams: [{
        codec_type: "video",
        side_data_list: [
          { side_data_type: "Content light level metadata", max_content: 0 },
          { side_data_type: "Mastering display metadata", max_luminance: "40000000/10000" },
        ],
      }],
    });
    expect(mastered.hdrPeakNits).toBe(4000);

    const hostile = parseProbeOutput({
      streams: [{ codec_type: "video", side_data_list: [{ max_content: "1/0", max_luminance: 50_000 }] }],
    });
    expect(hostile.hdrPeakNits).toBe(10_000);
  });

  it("reads HDR peak metadata from a decoded frame when the stream omits it", () => {
    const info = parseProbeOutput({
      streams: [{ codec_type: "video", color_transfer: "smpte2084" }],
      frames: [{
        media_type: "video",
        side_data_list: [{ side_data_type: "Content light level metadata", max_content: 1500 }],
      }],
    });
    expect(info.hdrPeakNits).toBe(1500);
  });

  it("never borrows frame peak metadata from a different video stream", () => {
    const info = parseProbeOutput({
      streams: [
        { index: 0, codec_type: "video", color_transfer: "smpte2084", disposition: { default: 0 } },
        { index: 1, codec_type: "video", color_transfer: "smpte2084", disposition: { default: 1 } },
      ],
      frames: [{ media_type: "video", stream_index: 0, side_data_list: [{ max_content: 4000 }] }],
    });
    expect(info.videoStreamIndex).toBe(1);
    expect(info.hdrPeakNits).toBe(0);
  });

  it("prefers declared component depth and defaults malformed color metadata", () => {
    const info = parseProbeOutput({
      streams: [{
        codec_type: "video",
        pix_fmt: "p010le",
        bits_per_raw_sample: "12",
        color_transfer: 42,
      }],
    });

    expect(info.bitDepth).toBe(12);
    expect(info.colorTransfer).toBe("");
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
    expect(parseProbeOutput(null)).toMatchObject({
      pixelFormat: "",
      bitDepth: 0,
      colorPrimaries: "",
      colorTransfer: "",
      colorSpace: "",
      colorRange: "",
      hdrPeakNits: 0,
    });
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
