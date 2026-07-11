import { describe, it, expect } from "vitest";
import { buildCutArgs, buildJumpCutArgs, buildVideoFilters, escapeFilterPath, metadataArgs, parseFfmpegProgress, LOUDNORM_FILTER, LOUDNORM_OUT_RATE, DENOISE_FILTER } from "../cut";

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

  it("fontsDir: rides along as the subtitles filter's fontsdir", () => {
    const vf = buildVideoFilters({ subtitlePath: "/tmp/a.ass", fontsDir: "C:\\App\\fonts" });
    expect(vf[0]).toBe("subtitles=filename='/tmp/a.ass':fontsdir='C\\:/App/fonts'");
  });

  it("filters force accurate mode even when copy was requested", () => {
    const args = buildCutArgs("/v/in.mp4", "/v/out.mp4", 0, 5, { mode: "copy", vertical: true });
    expect(args).toContain("libx264");
    expect(args).not.toContain("make_zero");
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
    expect(args[af + 1]).toBe(LOUDNORM_FILTER);
    expect(args[args.indexOf("-ar") + 1]).toBe(LOUDNORM_OUT_RATE);
    expect(af).toBeLessThan(args.indexOf("-c:a")); // filter precedes the encoder
  });

  it("plain cut: no audio filter when disabled", () => {
    const args = buildCutArgs("/v/in.mp4", "/v/out.mp4", 0, 5);
    expect(args).not.toContain("-af");
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

  it("普通切割:仅降噪 → -af 只有降噪链,无 -ar,且强制重编码", () => {
    const args = buildCutArgs("/v/in.mp4", "/v/out.mp4", 0, 5, { mode: "copy", denoise: true });
    expect(args).toContain("libx264"); // copy 被升级
    expect(args[args.indexOf("-af") + 1]).toBe(DENOISE_FILTER);
    expect(args).not.toContain("-ar");
  });

  it("普通切割:降噪+响度 → 降噪排在 loudnorm 之前,-ar 照常", () => {
    const args = buildCutArgs("/v/in.mp4", "/v/out.mp4", 0, 5, { denoise: true, normalizeLoudness: true });
    expect(args[args.indexOf("-af") + 1]).toBe(`${DENOISE_FILTER},${LOUDNORM_FILTER}`);
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
