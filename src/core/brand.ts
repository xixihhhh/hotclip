/**
 * 品牌预设的纯逻辑:hex 颜色 → ASS 颜色转换、字号/位置档位应用到字幕布局、
 * 参数消毒。UI 配一次,每条切片的 ASS 字幕/气泡字幕/水印全部复用。
 */
import type { AssLayout } from "./subtitle";
import { FONT_SCALE_CHOICES, type BrandStyle } from "../shared/api-types";
import { HEX_RE, clampFontScale } from "../shared/brand-style";
export { DEFAULT_HIGHLIGHT_HEX, isValidHex, sanitizeBrand } from "../shared/brand-style";

export { FONT_SCALE_CHOICES } from "../shared/api-types";

/** 字幕位置三档 → 基准 marginV 的倍率(竖屏 560→420/560/700,横屏同比)。 */
const POSITION_FACTOR = { low: 0.75, standard: 1, high: 1.25 } as const;

/**
 * "#RRGGBB" → ASS 样式表颜色 "&HAABBGGRR"(注意 BGR 序)。
 * 非法输入返回 null,调用方回落默认色。
 */
export function hexToAssColor(hex: string, alphaHex = "00"): string | null {
  const m = HEX_RE.exec(hex);
  if (!m) return null;
  const [r, g, b] = [m[1].slice(0, 2), m[1].slice(2, 4), m[1].slice(4, 6)];
  return `&H${alphaHex}${b}${g}${r}`.toUpperCase();
}

/** "#RRGGBB" → ASS 行内覆写形式 "&HBBGGRR&"(\c 用,无 alpha 字节)。 */
export function hexToAssInline(hex: string): string | null {
  const m = HEX_RE.exec(hex);
  if (!m) return null;
  return `&H${m[1].slice(4, 6)}${m[1].slice(2, 4)}${m[1].slice(0, 2)}&`.toUpperCase();
}

/** 向白色混合提亮(气泡字幕渐变的第二停靠色)。frac=0 原色,1 纯白。 */
export function lightenHex(hex: string, frac: number): string {
  const m = HEX_RE.exec(hex);
  if (!m) return hex;
  const mix = (c: number): string =>
    Math.round(c + (255 - c) * Math.max(0, Math.min(1, frac)))
      .toString(16)
      .padStart(2, "0");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  return `#${mix(r)}${mix(g)}${mix(b)}`.toUpperCase();
}

/**
 * 把品牌的字号/位置档位应用到基准布局。字号放大时每行容纳的宽度单位
 * 同比减少(否则换行会溢出安全区);位置档位只动 marginV。
 */
export function applyBrandToLayout(layout: AssLayout, brand?: BrandStyle): AssLayout {
  if (!brand) return layout;
  const scale = clampFontScale(brand.fontScale);
  const posFactor = POSITION_FACTOR[brand.captionPosition ?? "standard"] ?? 1;
  if (scale === 1 && posFactor === 1) return layout;
  return {
    ...layout,
    fontSize: Math.round(layout.fontSize * scale),
    maxLineUnits: Math.max(6, Math.round(layout.maxLineUnits / scale)),
    marginV: Math.round(layout.marginV * posFactor),
  };
}
