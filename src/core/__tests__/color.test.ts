import { describe, expect, it } from "vitest";
import type { MediaInfo } from "../probe";
import { colorOutputArgs, hdrToneMapFilter, isExecutableColorPlan, isHdrSource, planColorRender } from "../color";

function media(overrides: Partial<MediaInfo> = {}): MediaInfo {
  return {
    durationSec: 60,
    hasVideo: true,
    hasAudio: true,
    width: 3840,
    height: 2160,
    fps: 30,
    bitRate: 20_000_000,
    videoCodec: "hevc",
    audioCodec: "aac",
    ...overrides,
  };
}

describe("planColorRender", () => {
  it("plans an explicit PQ to BT.709 transform", () => {
    const plan = planColorRender(media({
      pixelFormat: "YUV420P10LE",
      bitDepth: 10,
      colorPrimaries: "BT2020",
      colorTransfer: "SMPTE2084",
      colorSpace: "BT2020NC",
      colorRange: "TV",
    }));

    expect(plan).toEqual({
      source: {
        pixelFormat: "yuv420p10le",
        bitDepth: 10,
        primaries: "bt2020",
        transfer: "smpte2084",
        space: "bt2020nc",
        range: "tv",
        peakNits: 0,
      },
      detected: "pq",
      action: "tonemap-bt709",
      output: {
        pixelFormat: "yuv420p",
        bitDepth: 8,
        primaries: "bt709",
        transfer: "bt709",
        space: "bt709",
        range: "tv",
        peakNits: 100,
      },
      reason: "hdr-pq-tone-map-bt709",
    });
  });

  it("plans the same safe transform for explicit HLG", () => {
    const plan = planColorRender(media({
      colorPrimaries: "bt2020",
      colorTransfer: "arib-std-b67",
      colorSpace: "bt2020nc",
      colorRange: "tv",
    }));
    expect(plan.detected).toBe("hlg");
    expect(plan.action).toBe("tonemap-bt709");
    expect(plan.output?.transfer).toBe("bt709");
    expect(isExecutableColorPlan(plan)).toBe(true);
  });

  it("detects HDR but fails open when the input colour path is incomplete", () => {
    const plan = planColorRender(media({ colorTransfer: "smpte2084" }));
    expect(plan).toMatchObject({
      detected: "pq",
      action: "passthrough",
      output: null,
      reason: "hdr-pq-unsupported-color-path-passthrough",
    });
    expect(isHdrSource(plan)).toBe(true);
  });

  it("fails open when an HDR matrix is unknown instead of guessing BT.2020", () => {
    const plan = planColorRender(media({
      colorPrimaries: "bt2020",
      colorTransfer: "arib-std-b67",
      colorSpace: "unknown",
      colorRange: "tv",
    }));
    expect(plan).toMatchObject({
      detected: "hlg",
      action: "passthrough",
      output: null,
      reason: "hdr-hlg-unsupported-color-path-passthrough",
    });
  });

  it("rejects HDR matrix names not verified by the bundled zscale runtime", () => {
    const plan = planColorRender(media({
      colorPrimaries: "bt2020",
      colorTransfer: "smpte2084",
      colorSpace: "smpte2085",
      colorRange: "tv",
    }));
    expect(plan).toMatchObject({
      detected: "pq",
      action: "passthrough",
      reason: "hdr-pq-unsupported-color-path-passthrough",
    });
  });

  it("rejects BT.2020 constant-luminance HDR because the bundled transform cannot execute it", () => {
    const plan = planColorRender(media({
      colorPrimaries: "bt2020",
      colorTransfer: "arib-std-b67",
      colorSpace: "bt2020c",
      colorRange: "pc",
    }));
    expect(plan).toMatchObject({
      detected: "hlg",
      action: "passthrough",
      reason: "hdr-hlg-unsupported-color-path-passthrough",
    });
  });

  it("passes SDR through without manufacturing output metadata", () => {
    const plan = planColorRender(media({ colorTransfer: "bt709" }));
    expect(isHdrSource(plan)).toBe(false);
    expect(plan).toMatchObject({
      detected: "sdr",
      action: "passthrough",
      output: null,
      reason: "sdr-transfer-passthrough",
    });
  });

  it("does not guess HDR from a 10-bit BT.2020 stream without a known transfer", () => {
    const plan = planColorRender(media({
      pixelFormat: "yuv420p10le",
      bitDepth: 10,
      colorPrimaries: "bt2020",
      colorTransfer: "unspecified",
      colorSpace: "bt2020nc",
    }));

    expect(plan.detected).toBe("unknown");
    expect(plan.action).toBe("passthrough");
    expect(plan.output).toBeNull();
  });

  it("keeps legacy MediaInfo fixtures safe", () => {
    const plan = planColorRender(media());
    expect(plan.source).toEqual({
      pixelFormat: "",
      bitDepth: 0,
      primaries: "",
      transfer: "",
      space: "",
      range: "",
      peakNits: 0,
    });
    expect(plan.detected).toBe("unknown");
    expect(plan.action).toBe("passthrough");
  });
});

describe("HDR FFmpeg helpers", () => {
  it("returns the verified linear-light Mobius chain and BT.709 tags", () => {
    const plan = planColorRender(media({
      colorPrimaries: "bt2020",
      colorTransfer: "smpte2084",
      colorSpace: "bt2020nc",
      colorRange: "tv",
    }));
    expect(hdrToneMapFilter(plan)).toBe(
      "zscale=pin=bt2020:tin=smpte2084:min=bt2020nc:rin=tv:t=linear:npl=100,format=gbrpf32le,tonemap=tonemap=mobius:desat=2,zscale=p=bt709:t=bt709:m=bt709:r=tv:dither=error_diffusion,format=yuv420p"
    );
    expect(colorOutputArgs(plan)).toEqual([
      "-color_primaries", "bt709",
      "-color_trc", "bt709",
      "-colorspace", "bt709",
      "-color_range", "tv",
    ]);
  });

  it("leaves peak automatic when static HDR metadata is absent", () => {
    const common = {
      colorPrimaries: "bt2020",
      colorSpace: "bt2020nc",
      colorRange: "tv",
    };
    const pq = planColorRender(media({ ...common, colorTransfer: "smpte2084" }));
    const hlg = planColorRender(media({ ...common, colorTransfer: "arib-std-b67" }));
    expect(hdrToneMapFilter(pq)).not.toContain(":peak=");
    expect(hdrToneMapFilter(hlg)).not.toContain(":peak=");
  });

  it("prefers static MaxCLL/mastering peak metadata over the fallback", () => {
    const plan = planColorRender(media({
      colorPrimaries: "bt2020",
      colorTransfer: "smpte2084",
      colorSpace: "bt2020nc",
      colorRange: "tv",
      hdrPeakNits: 4000,
    }));
    expect(plan.source.peakNits).toBe(4000);
    expect(hdrToneMapFilter(plan)).toContain("peak=40");
  });

  it("does not change the SDR/unknown render path", () => {
    const plan = planColorRender(media({ colorTransfer: "bt709" }));
    expect(hdrToneMapFilter(plan)).toBeNull();
    expect(colorOutputArgs(plan)).toEqual([]);
    expect(hdrToneMapFilter(undefined)).toBeNull();
    expect(colorOutputArgs(null)).toEqual([]);
  });

  it("refuses a stale or manually forged active plan with an unsupported input path", () => {
    const valid = planColorRender(media({
      colorPrimaries: "bt2020",
      colorTransfer: "smpte2084",
      colorSpace: "bt2020nc",
      colorRange: "tv",
    }));
    const forged = { ...valid, source: { ...valid.source, space: "smpte2085" } };
    expect(isExecutableColorPlan(forged)).toBe(false);
    expect(hdrToneMapFilter(forged)).toBeNull();
    expect(colorOutputArgs(forged)).toEqual([]);
  });
});
