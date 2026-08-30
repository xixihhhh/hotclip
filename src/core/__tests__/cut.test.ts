import { describe, it, expect } from "vitest";
import { buildCutArgs, buildJumpCutArgs, buildVideoFilters, escapeFilterPath, metadataArgs, parseFfmpegProgress, edgeFadeFilters, LOUDNORM_FILTER, LOUDNORM_OUT_RATE, DENOISE_FILTER, EDGE_FADE_SEC } from "../cut";
import type { ColorRenderPlan } from "../color";
import type { VisualEnhancePlan } from "../visual-enhance";

function colorPlan(detected: "pq" | "hlg" | "sdr"): ColorRenderPlan {
  const hdr = detected !== "sdr";
  return {
    source: {
      pixelFormat: hdr ? "yuv420p10le" : "yuv420p",
      bitDepth: hdr ? 10 : 8,
      primaries: hdr ? "bt2020" : "bt709",
      transfer: detected === "pq" ? "smpte2084" : detected === "hlg" ? "arib-std-b67" : "bt709",
      space: hdr ? "bt2020nc" : "bt709",
      range: "tv",
      peakNits: hdr ? 0 : 100,
    },
    detected,
    action: hdr ? "tonemap-bt709" : "passthrough",
    output: hdr
      ? {
          pixelFormat: "yuv420p",
          bitDepth: 8,
          primaries: "bt709",
          transfer: "bt709",
          space: "bt709",
          range: "tv",
          peakNits: 100,
        }
      : null,
    reason: hdr ? `hdr-${detected}-tone-map-bt709` : "sdr-transfer-passthrough",
  };
}

describe("buildCutArgs", () => {
  it("accurate mode: fast seek before -i, re-encode, faststart", () => {
    const args = buildCutArgs("/v/in.mp4", "/v/out.mp4", 61.5, 91.5);
    const ss = args.indexOf("-ss");
    const i = args.indexOf("-i");
    expect(ss).toBeGreaterThan(-1);
    expect(ss).toBeLessThan(i); // fast seek must precede the input
    expect(args[ss + 1]).toBe("00:01:01.500");
    expect(args).toContain("-t");
    expect(args[args.indexOf("-t") + 1]).toBe("00:00:30.000");
    expect(args).toContain("libx264");
    expect(args).toContain("+faststart");
    expect(args[args.length - 1]).toBe("/v/out.mp4");
  });

  it("maps the probed global video/audio streams in continuous and jump-cut paths", () => {
    const selected = { videoStreamIndex: 1, audioStreamIndex: 2 };
    const continuous = buildCutArgs("/v/in.mkv", "/v/out.mp4", 0, 5, selected);
    expect(continuous.slice(continuous.indexOf("-map"), continuous.indexOf("-map") + 4)).toEqual([
      "-map", "0:1", "-map", "0:2",
    ]);

    const jump = buildJumpCutArgs(
      "/v/in.mkv",
      "/v/out.mp4",
      0,
      [{ startSec: 0, endSec: 2 }, { startSec: 3, endSec: 5 }],
      selected
    );
    const graph = jump[jump.indexOf("-filter_complex") + 1];
    expect(graph).toContain("[0:1]trim=start=0.000:end=2.000");
    expect(graph).toContain("[0:2]atrim=start=0.000:end=2.000");
  });

  it("copy mode: stream copy, no encoder flags", () => {
    const args = buildCutArgs("/v/in.mp4", "/v/out.mp4", 10, 20, { mode: "copy" });
    expect(args).toContain("copy");
    expect(args).not.toContain("libx264");
    expect(args).toContain("make_zero");
  });

  it("clamps negative start to zero", () => {
    const args = buildCutArgs("/v/in.mp4", "/v/out.mp4", -2, 8);
    expect(args[args.indexOf("-ss") + 1]).toBe("00:00:00.000");
    expect(args[args.indexOf("-t") + 1]).toBe("00:00:08.000");
  });

  it("rejects inverted/empty ranges", () => {
    expect(() => buildCutArgs("/v/in.mp4", "/v/out.mp4", 30, 30)).toThrow();
    expect(() => buildCutArgs("/v/in.mp4", "/v/out.mp4", 30, 10)).toThrow();
  });

  it("honors custom crf/preset", () => {
    const args = buildCutArgs("/v/in.mp4", "/v/out.mp4", 0, 5, { crf: 20, preset: "medium" });
    expect(args[args.indexOf("-crf") + 1]).toBe("20");
    expect(args[args.indexOf("-preset") + 1]).toBe("medium");
  });

  it("vertical: center-crop to 9:16 then 1080×1920", () => {
    const args = buildCutArgs("/v/in.mp4", "/v/out.mp4", 0, 5, { vertical: true });
    const vf = args[args.indexOf("-vf") + 1];
    expect(vf).toContain("crop=w='min(iw,ih*9/16)'");
    expect(vf).toContain("scale=1080:1920");
    expect(vf).toContain("setsar=1");
  });

  it("subtitlePath: appends the subtitles filter after reframing", () => {
    const vf = buildVideoFilters({ vertical: true, subtitlePath: "/tmp/a.ass" });
    expect(vf[vf.length - 1]).toBe("subtitles=filename='/tmp/a.ass'");
    expect(vf[0]).toContain("crop=");
  });

  it("adaptive picture finish runs after geometry and before subtitles", () => {
    const visualEnhance: VisualEnhancePlan = {
      applied: true,
      sampleCount: 8,
      measurements: { lumaLow: 20, lumaAvg: 55, lumaHigh: 105, saturation: 16 },
      adjustments: { brightness: 0.012, contrast: 1.08, saturation: 1.08, gamma: 1.08 },
      reasons: ["underexposed", "flat", "muted"],
    };
    const vf = buildVideoFilters({ vertical: true, visualEnhance, subtitlePath: "/tmp/a.ass" });
    expect(vf.findIndex((filter) => filter.startsWith("eq="))).toBeGreaterThan(vf.findIndex((filter) => filter.startsWith("scale=")));
    expect(vf.findIndex((filter) => filter.startsWith("eq="))).toBeLessThan(vf.findIndex((filter) => filter.startsWith("subtitles=")));
  });

  it("active finish disables copy while a neutral plan preserves it", () => {
    const active: VisualEnhancePlan = {
      applied: true,
      sampleCount: 8,
      measurements: { lumaLow: 20, lumaAvg: 55, lumaHigh: 105, saturation: 16 },
      adjustments: { brightness: 0.012, contrast: 1.08, saturation: 1.08, gamma: 1.08 },
      reasons: ["underexposed"],
    };
    const neutral: VisualEnhancePlan = { ...active, applied: false, adjustments: { brightness: 0, contrast: 1, saturation: 1, gamma: 1 }, reasons: [] };
    expect(buildCutArgs("/i.mp4", "/o.mp4", 0, 5, { mode: "copy", visualEnhance: active })).toContain("libx264");
    expect(buildCutArgs("/i.mp4", "/o.mp4", 0, 5, { mode: "copy", visualEnhance: neutral })).toContain("make_zero");
  });

  it("applies the same finish to the concatenated jump-cut picture", () => {
    const visualEnhance: VisualEnhancePlan = {
      applied: true,
      sampleCount: 8,
      measurements: { lumaLow: 20, lumaAvg: 55, lumaHigh: 105, saturation: 16 },
      adjustments: { brightness: 0.012, contrast: 1.08, saturation: 1.08, gamma: 1.08 },
      reasons: ["underexposed"],
    };
    const args = buildJumpCutArgs("/i.mp4", "/o.mp4", 0, [{ startSec: 0, endSec: 2 }, { startSec: 3, endSec: 5 }], {
      visualEnhance,
      subtitlePath: "/tmp/a.ass",
    });
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).toContain("[vc]eq=brightness=");
    expect(graph.indexOf("eq=brightness=")).toBeLessThan(graph.indexOf("subtitles=filename="));
  });

  it("keeps undefined and explicit SDR color plans on the legacy argument path", () => {
    const legacy = buildCutArgs("/i.mp4", "/o.mp4", 0, 5, { mode: "copy" });
    const sdr = buildCutArgs("/i.mp4", "/o.mp4", 0, 5, { mode: "copy", color: colorPlan("sdr") });
    expect(sdr).toEqual(legacy);
    expect(buildVideoFilters({ color: colorPlan("sdr") })).toEqual([]);
  });

  it("tone-maps PQ before every geometry/finish/text stage, tags SDR, and disables both copy paths", () => {
    const visualEnhance: VisualEnhancePlan = {
      applied: true,
      sampleCount: 8,
      measurements: { lumaLow: 20, lumaAvg: 55, lumaHigh: 105, saturation: 16 },
      adjustments: { brightness: 0.012, contrast: 1.08, saturation: 1.08, gamma: 1.08 },
      reasons: ["underexposed"],
    };
    const options = {
      mode: "copy" as const,
      videoCopy: true,
      color: colorPlan("pq"),
      uiCrop: { topFrac: 0.05, bottomFrac: 0.03 },
      vertical: true,
      autoZoom: { durationSec: 5, fps: 30 },
      visualEnhance,
      subtitlePath: "/tmp/a.ass",
    };
    const filters = buildVideoFilters(options);
    expect(filters[0]).toBe(
      "zscale=pin=bt2020:tin=smpte2084:min=bt2020nc:rin=tv:t=linear:npl=100,format=gbrpf32le,tonemap=tonemap=mobius:desat=2,zscale=p=bt709:t=bt709:m=bt709:r=tv:dither=error_diffusion,format=yuv420p"
    );
    expect(filters.findIndex((filter) => filter.startsWith("crop="))).toBeGreaterThan(0);
    expect(filters.findIndex((filter) => filter.startsWith("zoompan="))).toBeGreaterThan(0);
    expect(filters.findIndex((filter) => filter.startsWith("eq="))).toBeGreaterThan(0);
    expect(filters.findIndex((filter) => filter.startsWith("subtitles="))).toBeGreaterThan(0);

    const args = buildCutArgs("/i.mp4", "/o.mp4", 0, 5, options);
    expect(args).toContain("libx264");
    expect(args.slice(args.indexOf("-c:v"), args.indexOf("-c:v") + 2)).not.toEqual(["-c:v", "copy"]);
    expect(args.slice(args.indexOf("-color_primaries"), args.indexOf("-color_primaries") + 8)).toEqual([
      "-color_primaries", "bt709",
      "-color_trc", "bt709",
      "-colorspace", "bt709",
      "-color_range", "tv",
    ]);
  });

  it("keeps HLG tone mapping first on tracked reframes", () => {
    const filters = buildVideoFilters({
      color: colorPlan("hlg"),
      trackPlan: { cropXExpr: "100", cropW: 1080, cropH: 1920, cropY: 0 },
      subtitlePath: "/tmp/a.ass",
    });
    expect(filters[0]).toContain("tonemap=tonemap=mobius");
    expect(filters[1]).toBe("crop=w=1080:h=1920:x='100':y=0");
    expect(filters.findIndex((filter) => filter.startsWith("subtitles="))).toBeGreaterThan(1);
  });

  it("applies the same HDR transform and BT.709 tags to jump cuts", () => {
    const args = buildJumpCutArgs(
      "/i.mp4",
      "/o.mp4",
      0,
      [{ startSec: 0, endSec: 2 }, { startSec: 3, endSec: 5 }],
      { color: colorPlan("hlg"), vertical: true, subtitlePath: "/tmp/a.ass" }
    );
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).toContain("[vc]zscale=pin=bt2020:tin=arib-std-b67");
    expect(graph.indexOf("zscale=pin=bt2020")).toBeLessThan(graph.indexOf("crop=w='min(iw,ih*9/16)'"));
    expect(graph.indexOf("crop=w='min(iw,ih*9/16)'")).toBeLessThan(graph.indexOf("subtitles=filename="));
    expect(args.slice(args.indexOf("-color_primaries"), args.indexOf("-color_primaries") + 8)).toEqual([
      "-color_primaries", "bt709",
      "-color_trc", "bt709",
      "-colorspace", "bt709",
      "-color_range", "tv",
    ]);
  });

  it("fontsDir: rides along as the subtitles filter's fontsdir", () => {
    const vf = buildVideoFilters({ subtitlePath: "/tmp/a.ass", fontsDir: "C:\\App\\fonts" });
    expect(vf[0]).toBe("subtitles=filename='/tmp/a.ass':fontsdir='C\\:/App/fonts'");
  });

  it("filters force accurate mode even when copy was requested", () => {
    const args = buildCutArgs("/v/in.mp4", "/v/out.mp4", 0, 5, { mode: "copy", vertical: true });
    expect(args).toContain("libx264");
    expect(args).not.toContain("make_zero");
  });

  it("smart video copy preserves AAC and the complete audio filter chain", () => {
    const args = buildCutArgs("/v/in.mp4", "/v/out.mp4", 10, 20, {
      videoCopy: true,
      denoise: true,
      normalizeLoudness: true,
      muteRanges: [{ startSec: 1, endSec: 2 }],
    });
    expect(args.slice(args.indexOf("-c:v"), args.indexOf("-c:v") + 2)).toEqual(["-c:v", "copy"]);
    expect(args).not.toContain("libx264");
    expect(args.slice(args.indexOf("-c:a"), args.indexOf("-c:a") + 2)).toEqual(["-c:a", "aac"]);
    const audio = args[args.indexOf("-af") + 1];
    expect(audio).toContain(DENOISE_FILTER);
    expect(audio).toContain(LOUDNORM_FILTER);
    expect(audio).toContain("volume=enable='between(t,1.000,2.000)':volume=0");
    expect(audio).toContain("afade=t=in");
  });

  it("pixel-changing filters disable smart video copy", () => {
    const args = buildCutArgs("/v/in.mp4", "/v/out.mp4", 0, 5, { videoCopy: true, vertical: true });
    expect(args).toContain("libx264");
    expect(args.slice(args.indexOf("-c:v"), args.indexOf("-c:v") + 2)).toEqual(["-c:v", "libx264"]);
  });

  it("escapes windows drive colons and backslashes for the filter graph", () => {
    expect(escapeFilterPath("C:\\Users\\我\\a.ass")).toBe("C\\:/Users/我/a.ass");
  });
});

describe("loudness normalization", () => {
  it("targets -14 LUFS; the 192kHz leak is capped by the -ar output option, not an in-graph resampler", () => {
    expect(LOUDNORM_FILTER).toContain("loudnorm=I=-14");
    expect(LOUDNORM_FILTER).toContain("TP=-1.5");
    // in-graph aresample breaks channel-layout negotiation with the AAC encoder
    expect(LOUDNORM_FILTER).not.toContain("aresample");
    expect(LOUDNORM_OUT_RATE).toBe("48000");
  });

  it("plain cut: inserts -af loudnorm + -ar before the audio codec when enabled", () => {
    const args = buildCutArgs("/v/in.mp4", "/v/out.mp4", 0, 5, { normalizeLoudness: true });
    const af = args.indexOf("-af");
    expect(af).toBeGreaterThan(-1);
    expect(args[af + 1].startsWith(LOUDNORM_FILTER)).toBe(true); // 边缘淡化排在其后
    expect(args[args.indexOf("-ar") + 1]).toBe(LOUDNORM_OUT_RATE);
    expect(af).toBeLessThan(args.indexOf("-c:a")); // filter precedes the encoder
  });

  it("plain cut: 关掉响度后 -af 只剩边缘淡化,无 loudnorm", () => {
    const args = buildCutArgs("/v/in.mp4", "/v/out.mp4", 0, 5);
    expect(args[args.indexOf("-af") + 1]).toBe("afade=t=in:st=0:d=0.03,afade=t=out:st=4.970:d=0.03");
    expect(args.join(" ")).not.toContain("loudnorm");
  });

  it("plain cut: loudnorm alone forces accurate mode even if copy requested", () => {
    const args = buildCutArgs("/v/in.mp4", "/v/out.mp4", 0, 5, { mode: "copy", normalizeLoudness: true });
    expect(args).toContain("libx264");
    expect(args).toContain("-af");
    expect(args).not.toContain("make_zero");
  });

  it("jump cut: normalizes the spliced stream (concat → [araw] → loudnorm → [aout])", () => {
    const segs = [{ startSec: 10, endSec: 12 }, { startSec: 15, endSec: 17 }];
    const args = buildJumpCutArgs("/v/in.mp4", "/v/out.mp4", 10, segs, { normalizeLoudness: true });
    const fc = args[args.indexOf("-filter_complex") + 1];
    expect(fc).toContain(":a=1[vout][araw]"); // concat audio → raw label
    expect(fc).toContain(`[araw]${LOUDNORM_FILTER}[aout]`); // then normalize
    expect(args[args.indexOf("-map") + 1]).toBe("[vout]");
    expect(args).toContain("[aout]"); // final audio map unchanged
    expect(args[args.indexOf("-ar") + 1]).toBe(LOUDNORM_OUT_RATE); // cap the 192kHz output
  });

  it("jump cut: concat maps straight to [aout] when disabled", () => {
    const segs = [{ startSec: 10, endSec: 12 }, { startSec: 15, endSec: 17 }];
    const fc = buildJumpCutArgs("/v/in.mp4", "/v/out.mp4", 10, segs)[
      buildJumpCutArgs("/v/in.mp4", "/v/out.mp4", 10, segs).indexOf("-filter_complex") + 1
    ];
    expect(fc).toContain(":a=1[vout][aout]");
    expect(fc).not.toContain("loudnorm");
  });
});

describe("denoise (基础降噪)", () => {
  it("链路含双高通与 afftdn,不含 aresample", () => {
    expect(DENOISE_FILTER).toContain("highpass=f=80,highpass=f=80");
    expect(DENOISE_FILTER).toContain("afftdn");
    expect(DENOISE_FILTER).not.toContain("aresample");
  });

  it("普通切割:仅降噪 → -af 以降噪链开头(后接边缘淡化),无 -ar,且强制重编码", () => {
    const args = buildCutArgs("/v/in.mp4", "/v/out.mp4", 0, 5, { mode: "copy", denoise: true });
    expect(args).toContain("libx264"); // copy 被升级
    expect(args[args.indexOf("-af") + 1].startsWith(DENOISE_FILTER)).toBe(true);
    expect(args).not.toContain("-ar");
  });

  it("普通切割:降噪+响度 → 降噪排在 loudnorm 之前,-ar 照常", () => {
    const args = buildCutArgs("/v/in.mp4", "/v/out.mp4", 0, 5, { denoise: true, normalizeLoudness: true });
    expect(args[args.indexOf("-af") + 1].startsWith(`${DENOISE_FILTER},${LOUDNORM_FILTER}`)).toBe(true);
    expect(args[args.indexOf("-ar") + 1]).toBe(LOUDNORM_OUT_RATE);
  });

  it("跳剪:拼接后整段过降噪链([araw] → 降噪,loudnorm → [aout])", () => {
    const segs = [{ startSec: 10, endSec: 12 }, { startSec: 15, endSec: 17 }];
    const args = buildJumpCutArgs("/v/in.mp4", "/v/out.mp4", 10, segs, { denoise: true, normalizeLoudness: true });
    const fc = args[args.indexOf("-filter_complex") + 1];
    expect(fc).toContain(":a=1[vout][araw]");
    expect(fc).toContain(`[araw]${DENOISE_FILTER},${LOUDNORM_FILTER}[aout]`);
  });

  it("跳剪:仅降噪也走 [araw] 链,不带 loudnorm/-ar", () => {
    const segs = [{ startSec: 10, endSec: 12 }, { startSec: 15, endSec: 17 }];
    const args = buildJumpCutArgs("/v/in.mp4", "/v/out.mp4", 10, segs, { denoise: true });
    const fc = args[args.indexOf("-filter_complex") + 1];
    expect(fc).toContain(`[araw]${DENOISE_FILTER}[aout]`);
    expect(fc).not.toContain("loudnorm");
    expect(args).not.toContain("-ar");
  });
});

describe("edgeFadeFilters (切点边缘 30ms 淡化防爆音)", () => {
  it("正常段:头淡入 + 尾淡出,尾部时刻 = 段长 - 淡化时长", () => {
    const fades = edgeFadeFilters(2);
    expect(fades).toEqual([
      `afade=t=in:st=0:d=${EDGE_FADE_SEC}`,
      `afade=t=out:st=${(2 - EDGE_FADE_SEC).toFixed(3)}:d=${EDGE_FADE_SEC}`,
    ]);
  });

  it("超短段(≤4×淡化时长)不淡:淡化会吃掉整段能量", () => {
    expect(edgeFadeFilters(0.1)).toEqual([]);
    expect(edgeFadeFilters(0)).toEqual([]);
  });

  it("copy 模式不受影响:流复制无法加滤镜", () => {
    const args = buildCutArgs("/v/in.mp4", "/v/out.mp4", 10, 20, { mode: "copy" });
    expect(args.join(" ")).not.toContain("afade");
  });

  it("跳剪:每段两端各自淡化,拼缝处淡出+淡入相接", () => {
    const segs = [{ startSec: 10, endSec: 12 }, { startSec: 15, endSec: 17 }];
    const args = buildJumpCutArgs("/v/in.mp4", "/v/out.mp4", 10, segs);
    const fc = args[args.indexOf("-filter_complex") + 1];
    // 两段各带一对淡化(2 段 × in/out)
    expect(fc.match(/afade=t=in/g)).toHaveLength(2);
    expect(fc.match(/afade=t=out/g)).toHaveLength(2);
    // 淡化挂在 asetpts 之后、进 concat 之前(段内相对时间轴)
    expect(fc).toContain(`asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${EDGE_FADE_SEC},afade=t=out:st=1.970:d=${EDGE_FADE_SEC}[a0]`);
  });
});

describe("metadataArgs (AIGC 隐式标识)", () => {
  it("k=v 对展开;空缺省为空数组", () => {
    expect(metadataArgs({ comment: "AIGC=true; Tool=HotClip" })).toEqual(["-metadata", "comment=AIGC=true; Tool=HotClip"]);
    expect(metadataArgs(undefined)).toEqual([]);
  });

  it("三条出片路径都带 -metadata", () => {
    const meta = { comment: "AIGC=true" };
    const cut = buildCutArgs("/i.mp4", "/o.mp4", 0, 5, { metadata: meta, vertical: true });
    expect(cut.join(" ")).toContain("-metadata comment=AIGC=true");
    const jump = buildJumpCutArgs("/i.mp4", "/o.mp4", 0, [{ startSec: 0, endSec: 2 }, { startSec: 3, endSec: 5 }], { metadata: meta });
    expect(jump.join(" ")).toContain("-metadata comment=AIGC=true");
    const copy = buildCutArgs("/i.mp4", "/o.mp4", 0, 5, { metadata: meta, mode: "copy" });
    expect(copy.join(" ")).toContain("-metadata comment=AIGC=true");
  });
});

describe("parseFfmpegProgress (切片内实时进度)", () => {
  it("解析 out_time_us(微秒)为秒;老字段 out_time_ms 同样按微秒", () => {
    expect(parseFfmpegProgress("frame=100\nout_time_us=2500000\nprogress=continue\n")).toBe(2.5);
    expect(parseFfmpegProgress("out_time_ms=1500000\n")).toBe(1.5);
  });

  it("无进度字段/垃圾块返回 null", () => {
    expect(parseFfmpegProgress("speed=2.5x\n")).toBeNull();
    expect(parseFfmpegProgress("")).toBeNull();
  });
});
