/**
 * 品牌预设的纯逻辑:hex 颜色 → ASS 颜色转换、字号/位置档位应用到字幕布局、
 * 参数消毒。UI 配一次,每条切片的 ASS 字幕/气泡字幕/水印全部复用。
 */
import type { AssLayout } from "./subtitle";
import type { BrandStyle } from "../shared/api-types";

/** 默认高亮色:火焰橙(与既有硬编码一致,未配置时输出不变)。 */
export const DEFAULT_HIGHLIGHT_HEX = "#FF6E0D";

/** 字号三档(UI 与管线共用;自由数值也接受,消毒时钳制)。 */
export const FONT_SCALE_CHOICES = { small: 0.85, standard: 1, large: 1.18 } as const;

/** 字幕位置三档 → 基准 marginV 的倍率(竖屏 560→420/560/700,横屏同比)。 */
const POSITION_FACTOR = { low: 0.75, standard: 1, high: 1.25 } as const;

const HEX_RE = /^#?([0-9a-fA-F]{6})$/;

/** "#RRGGBB" 是否为合法颜色。 */
export function isValidHex(hex: unknown): hex is string {
  return typeof hex === "string" && HEX_RE.test(hex);
}

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

function clampFontScale(scale: number | undefined): number {
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
