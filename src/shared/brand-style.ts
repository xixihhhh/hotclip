import { TITLE_STYLES, type BrandStyle, type TitleStyle } from "./api-types";

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

export function clampFontScale(scale: number | undefined): number {
  if (typeof scale !== "number" || !Number.isFinite(scale)) return 1;
  return Math.max(0.6, Math.min(1.6, scale));
}

/**
 * IPC 边界消毒:剔除非法字段,返回可以放心穿透管线的品牌参数。
 * 全部字段非法/缺省时返回 undefined(管线走原有默认,输出逐字节不变)。
 */
export function sanitizeBrand(raw: unknown): BrandStyle | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const b = raw as Record<string, unknown>;
  const out: BrandStyle = {};
  if (isValidHex(b.highlightColor)) {
    out.highlightColor = b.highlightColor.startsWith("#") ? b.highlightColor : `#${b.highlightColor}`;
  }
  if (typeof b.fontScale === "number" && Number.isFinite(b.fontScale)) {
    out.fontScale = clampFontScale(b.fontScale);
  }
  if (b.captionPosition === "low" || b.captionPosition === "standard" || b.captionPosition === "high") {
    out.captionPosition = b.captionPosition;
  }
  const titleStyle = TITLE_STYLES.find((id) => id === b.titleStyle);
  if (titleStyle) out.titleStyle = titleStyle;
  const wm = b.watermark as Record<string, unknown> | undefined;
  if (wm && typeof wm === "object" && typeof wm.path === "string" && wm.path.trim()) {
    const corner =
      wm.corner === "top-left" || wm.corner === "bottom-left" || wm.corner === "bottom-right"
        ? wm.corner
        : "top-right";
    const opacity =
      typeof wm.opacity === "number" && Number.isFinite(wm.opacity)
        ? Math.max(0.05, Math.min(1, wm.opacity))
        : 0.85;
    out.watermark = { path: wm.path, corner, opacity };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
