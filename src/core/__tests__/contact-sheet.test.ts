import { describe, it, expect } from "vitest";
import { chunkCells, buildSheetArgs, SHEET_CELLS } from "../contact-sheet";
import type { ColorRenderPlan } from "../color";

const pqPlan: ColorRenderPlan = {
  source: {
    pixelFormat: "yuv420p10le",
    bitDepth: 10,
    primaries: "bt2020",
    transfer: "smpte2084",
    space: "bt2020nc",
    range: "tv",
    peakNits: 1000,
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
};

describe("chunkCells", () => {
  it("按满格容量分组,最后一组可不满", () => {
    const groups = chunkCells(Array.from({ length: 20 }, (_, i) => i));
    expect(groups.map((g) => g.length)).toEqual([9, 9, 2]);
    expect(groups[0][0]).toBe(0);
    expect(groups[2]).toEqual([18, 19]);
  });

  it("空数组返回空;自定义容量生效", () => {
    expect(chunkCells([])).toEqual([]);
    expect(chunkCells([1, 2, 3], 2).map((g) => g.length)).toEqual([2, 1]);
  });
});

describe("buildSheetArgs", () => {
  it("满格:九路 -ss 输入,每路取一帧,concat 后 tile 3x3", () => {
    const times = Array.from({ length: SHEET_CELLS }, (_, i) => i * 10 + 5);
    const args = buildSheetArgs("/v.mp4", times);
    expect(args.filter((a) => a === "-i")).toHaveLength(9);
    expect(args.filter((a) => a === "/v.mp4")).toHaveLength(9);
    expect(args[args.indexOf("-ss") + 1]).toBe("5.00");
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).toContain("trim=end_frame=1"); // 每路只取一帧,concat 才不会等整条流
    expect(graph).toContain("concat=n=9:v=1:a=0");
    expect(graph).toContain("tile=3x3:color=black");
    expect(args[args.indexOf("-map") + 1]).toBe("[sheet]");
    expect(args).toContain("image2pipe");
  });

  it("不满格按需缩网格(4 帧 → 3x2,黑底补齐)", () => {
    const graph = buildSheetArgs("/v.mp4", [1, 2, 3, 4]).join(" ");
    expect(graph).toContain("tile=3x2");
  });

  it("两帧 → 2x1;单帧退化为不拼格", () => {
    expect(buildSheetArgs("/v.mp4", [1, 2]).join(" ")).toContain("tile=2x1");
    const single = buildSheetArgs("/v.mp4", [3]).join(" ");
    expect(single).not.toContain("tile=");
    expect(single).not.toContain("concat=");
    expect(single).toContain("[sheet]");
  });

  it("给了字体才烧序号,路径按 filter 语法转义", () => {
    const withFont = buildSheetArgs("/v.mp4", [1, 2], { fontFile: "C:\\fonts\\f.otf" }).join(" ");
    expect(withFont).toContain("drawtext=fontfile='C\\:/fonts/f.otf'");
    expect(withFont).toContain("text='1'");
    expect(withFont).toContain("text='2'");
    expect(buildSheetArgs("/v.mp4", [1, 2]).join(" ")).not.toContain("drawtext");
  });

  it("负时刻钳到 0,空时刻数组直接抛错", () => {
    const args = buildSheetArgs("/v.mp4", [-1]);
    expect(args[args.indexOf("-ss") + 1]).toBe("0.00");
    expect(() => buildSheetArgs("/v.mp4", [])).toThrow();
  });

  it("每路输入都取同一全局选中视频轨,HDR 预览先转 SDR 再缩放", () => {
    const args = buildSheetArgs("/v.mkv", [1, 2], { videoStreamIndex: 3, color: pqPlan });
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).toContain("[0:3]zscale=pin=bt2020");
    expect(graph).toContain("[1:3]zscale=pin=bt2020");
    expect(graph).toContain("trim=end_frame=1");
    expect(graph).not.toContain("[0:v]");
    expect(graph.indexOf("zscale=pin=bt2020")).toBeLessThan(graph.indexOf("scale=448:-2"));
    expect(graph).toContain("tonemap=tonemap=mobius");
  });
});
