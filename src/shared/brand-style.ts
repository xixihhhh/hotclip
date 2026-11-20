import type { TitleStyle } from "./api-types";

/** 默认高亮色:火焰橙(与既有硬编码一致,未配置时输出不变)。 */
export const DEFAULT_HIGHLIGHT_HEX = "#FF6E0D";

export const HEX_RE = /^#?([0-9a-fA-F]{6})$/;

/** "#RRGGBB" 是否为合法颜色。 */
export function isValidHex(hex: unknown): hex is string {
  return typeof hex === "string" && HEX_RE.test(hex);
}

/** Shared by the ASS renderer and the brand preview. Alpha uses ASS's 00 = opaque. */
export function resolveTitleStyle(style?: TitleStyle, highlight?: string) {
  if (style === "outline") {
    return { box: false, text: "#FFFFFF", border: "#000000", alpha: "00", width: 5 };
  }
  if (style === "brandPlate") {
    const border = isValidHex(highlight) ? `#${highlight.replace(/^#/, "")}` : DEFAULT_HIGHLIGHT_HEX;
    const [r, g, b] = [1, 3, 5].map((i) => {
      const v = parseInt(border.slice(i, i + 2), 16) / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return { box: true, text: luminance > 0.179 ? "#000000" : "#FFFFFF", border, alpha: "00", width: 12 };
  }
  return { box: true, text: "#FFFFFF", border: "#000000", alpha: "73", width: 12 };
}
