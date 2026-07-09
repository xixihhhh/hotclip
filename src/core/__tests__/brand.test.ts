import { describe, it, expect } from "vitest";
import {
  hexToAssColor,
  hexToAssInline,
  lightenHex,
  applyBrandToLayout,
  sanitizeBrand,
  isValidHex,
} from "../brand";
import { VERTICAL_LAYOUT, buildCaptionAss, keywordText } from "../subtitle";
import { buildOverlayPayload } from "../caption-overlay/payload";
import { watermarkStages, composeVideoFilter, buildCutArgs, buildJumpCutArgs } from "../cut";

describe("hex → ASS 颜色转换", () => {
  it("#RRGGBB → &HAABBGGRR(BGR 序)", () => {
    expect(hexToAssColor("#FF6E0D")).toBe("&H000D6EFF");
    expect(hexToAssColor("#3355FF", "7F")).toBe("&H7FFF5533");
    expect(hexToAssColor("22C55E")).toBe("&H005EC522"); // 无 # 前缀也接受
  });

  it("行内覆写形式 &HBBGGRR&", () => {
    expect(hexToAssInline("#FF6E0D")).toBe("&H0D6EFF&");
  });

  it("非法输入返回 null", () => {
    expect(hexToAssColor("#FFF")).toBeNull();
    expect(hexToAssColor("red")).toBeNull();
    expect(hexToAssInline("#GG0000")).toBeNull();
    expect(isValidHex("#12345")).toBe(false);
  });

  it("向白提亮(渐变第二停靠色)", () => {
    expect(lightenHex("#000000", 1)).toBe("#FFFFFF");
    expect(lightenHex("#FF6E0D", 0)).toBe("#FF6E0D");
    expect(lightenHex("bad", 0.5)).toBe("bad"); // 非法原样返回
  });
});

describe("applyBrandToLayout", () => {
  it("无品牌或全默认 → 布局原样(引用不变)", () => {
    expect(applyBrandToLayout(VERTICAL_LAYOUT)).toBe(VERTICAL_LAYOUT);
    expect(applyBrandToLayout(VERTICAL_LAYOUT, { highlightColor: "#123456" })).toBe(VERTICAL_LAYOUT);
  });

  it("字号放大 → 每行宽度单位同比减少", () => {
    const l = applyBrandToLayout(VERTICAL_LAYOUT, { fontScale: 1.18 });
    expect(l.fontSize).toBe(Math.round(78 * 1.18));
    expect(l.maxLineUnits).toBe(Math.round(22 / 1.18));
  });

  it("位置三档只动 marginV", () => {
    expect(applyBrandToLayout(VERTICAL_LAYOUT, { captionPosition: "low" }).marginV).toBe(420);
    expect(applyBrandToLayout(VERTICAL_LAYOUT, { captionPosition: "high" }).marginV).toBe(700);
  });
});

describe("sanitizeBrand(IPC 边界消毒)", () => {
  it("合法字段通过,非法字段剔除", () => {
    const b = sanitizeBrand({
      highlightColor: "#22C55E",
      fontScale: 99, // 超界 → 钳到 1.6
      captionPosition: "middle", // 非法档位 → 剔除
      watermark: { path: "/tmp/logo.png", corner: "nowhere", opacity: 5 },
    });
    expect(b).toEqual({
      highlightColor: "#22C55E",
      fontScale: 1.6,
      watermark: { path: "/tmp/logo.png", corner: "top-right", opacity: 1 },
    });
  });

  it("全空/非对象 → undefined(管线走默认)", () => {
    expect(sanitizeBrand(undefined)).toBeUndefined();
    expect(sanitizeBrand({})).toBeUndefined();
    expect(sanitizeBrand({ highlightColor: "nope" })).toBeUndefined();
  });
});

describe("品牌色贯穿字幕构建", () => {
  const words = [
    { text: "你好", startSec: 0.2, endSec: 0.8 },
    { text: "世界", startSec: 0.9, endSec: 1.5 },
  ];

  it("卡拉OK主色与钩子色用品牌色;缺省仍是火焰橙", () => {
    const branded = buildCaptionAss(words, 0, VERTICAL_LAYOUT, "karaoke", { highlightHex: "#22C55E" });
    expect(branded).toContain("&H005EC522");
    expect(branded).not.toContain("&H000D6EFF");
    const plain = buildCaptionAss(words, 0, VERTICAL_LAYOUT, "karaoke", {});
    expect(plain).toContain("&H000D6EFF");
  });

  it("关键词行内覆写用品牌色", () => {
    expect(keywordText(words, ["世界"], "#3355FF")).toContain("\\c&HFF5533&");
    expect(keywordText(words, ["世界"])).toContain("\\c&H0D6EFF&");
  });

  it("气泡 payload 带渐变双色;非法色回落默认", () => {
    const p = buildOverlayPayload(words, VERTICAL_LAYOUT, { highlightHex: "#3355FF" });
    expect(p.highlightColor).toBe("#3355FF");
    expect(p.highlightColor2).not.toBe("#3355FF"); // 已向白提亮
    expect(buildOverlayPayload(words, VERTICAL_LAYOUT, {}).highlightColor).toBe("#FF6E0D");
  });
});

describe("水印 filter 组装", () => {
  const wm = { path: "/tmp/logo.png", corner: "top-right" as const, opacity: 0.8, widthPx: 172 };

  it("movie 源 + 透明度 + 缩放,四角定位表达式", () => {
    const s = watermarkStages(wm);
    expect(s.source).toBe("movie='/tmp/logo.png',format=rgba,colorchannelmixer=aa=0.800,scale=172:-1");
    expect(s.overlay).toBe("overlay=W-w-44:44:format=auto");
    expect(watermarkStages({ ...wm, corner: "bottom-left" }).overlay).toBe("overlay=44:H-h-44:format=auto");
    // 不透明度 1 时省掉 mixer
    expect(watermarkStages({ ...wm, opacity: 1 }).source).not.toContain("colorchannelmixer");
  });

  it("composeVideoFilter:无水印原样;有水印起第二路;无前置链用 copy 垫底", () => {
    expect(composeVideoFilter(["scale=1080:1920"])).toBe("scale=1080:1920");
    expect(composeVideoFilter(["scale=1080:1920"], wm)).toBe(
      "scale=1080:1920[main];movie='/tmp/logo.png',format=rgba,colorchannelmixer=aa=0.800,scale=172:-1[wm];[main][wm]overlay=W-w-44:44:format=auto"
    );
    expect(composeVideoFilter([], wm)).toMatch(/^copy\[main\];/);
  });

  it("buildCutArgs:水印进 -vf 且强制重编码", () => {
    const args = buildCutArgs("/in.mp4", "/out.mp4", 0, 10, { mode: "copy", watermark: wm });
    const vf = args[args.indexOf("-vf") + 1];
    expect(vf).toContain("[main][wm]overlay=W-w-44:44");
    expect(args).toContain("libx264"); // copy 被升级为重编码
  });

  it("buildJumpCutArgs:水印叠在后处理链之后(字幕之上)", () => {
    const args = buildJumpCutArgs("/in.mp4", "/out.mp4", 0, [{ startSec: 0, endSec: 2 }, { startSec: 3, endSec: 5 }], {
      vertical: true,
      watermark: wm,
    });
    const fc = args[args.indexOf("-filter_complex") + 1];
    expect(fc).toContain("[vc]"); // concat 先出 [vc]
    expect(fc).toContain("[vmain][wm]overlay=W-w-44:44:format=auto[vout]");
    // 无后处理链时直接 [vc][wm] 收口
    const bare = buildJumpCutArgs("/in.mp4", "/out.mp4", 0, [{ startSec: 0, endSec: 2 }, { startSec: 3, endSec: 5 }], {
      watermark: wm,
    });
    const fcBare = bare[bare.indexOf("-filter_complex") + 1];
    expect(fcBare).toContain("[vc][wm]overlay=W-w-44:44:format=auto[vout]");
  });
});
