import { describe, it, expect } from "vitest";
import { buildCutArgs, buildVideoFilters, escapeFilterPath } from "../cut";

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

  it("filters force accurate mode even when copy was requested", () => {
    const args = buildCutArgs("/v/in.mp4", "/v/out.mp4", 0, 5, { mode: "copy", vertical: true });
    expect(args).toContain("libx264");
    expect(args).not.toContain("make_zero");
  });

  it("escapes windows drive colons and backslashes for the filter graph", () => {
    expect(escapeFilterPath("C:\\Users\\我\\a.ass")).toBe("C\\:/Users/我/a.ass");
  });
});
