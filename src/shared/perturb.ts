/**
 * 模板受控微扰(v0.14「发得出去、活得下来」):批量出片时按「源文件+切片」
 * 种子对字幕几何做小幅确定性抖动——字号 ±4%、字幕基线 ±1% 画高、水平边距
 * 几个像素——让同一账号(或矩阵账号)批量产出的成片不共享像素级相同的
 * 模板指纹。2026 平台的量产检测盯的是「同模板同版式大批量」,微扰幅度
 * 刻意压在观感无差的区间,且基线抖动后仍留在平台安全区(62-72% 字幕带)内。
 *
 * 确定性:同一种子永远得到同一组抖动——重新导出可复现,QA 能对账;
 * 不用 Math.random(不可复现,also 工作流环境禁用)。纯函数,无 Node 依赖。
 */

/** FNV-1a 32 位哈希:把种子字符串折成 PRNG 种子。 */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32:小而稳的种子化 PRNG(返回 [0,1) 均匀分布)。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 字号抖动幅度:±4%(78px 档约 ±3px,观感无差)。 */
export const JITTER_FONT_SPAN = 0.04;
/** 字幕基线抖动幅度:±1% 画高(1920 高约 ±19px,不出 62-72% 安全带)。 */
export const JITTER_BASELINE_FRAC = 0.01;
/** 水平边距抖动幅度:±8px(只影响留白,不动断行宽度)。 */
export const JITTER_MARGIN_H_PX = 8;

/** 微扰作用的最小布局面——core 的 AssLayout 结构性满足,shared 不反向依赖。 */
export interface JitterableLayout {
  playResY: number;
  fontSize: number;
  marginV: number;
  marginH: number;
}

/**
 * 按种子微扰一份字幕布局(字号/基线/水平边距)。同种子同输出;
 * 返回新对象,不改入参。
 */
export function perturbLayout<T extends JitterableLayout>(layout: T, seedKey: string): T {
  const rand = mulberry32(fnv1a(seedKey));
  const fontScale = 1 + (rand() * 2 - 1) * JITTER_FONT_SPAN;
  const marginVShift = Math.round((rand() * 2 - 1) * JITTER_BASELINE_FRAC * layout.playResY);
  const marginHShift = Math.round((rand() * 2 - 1) * JITTER_MARGIN_H_PX);
  return {
    ...layout,
    fontSize: Math.max(12, Math.round(layout.fontSize * fontScale)),
    marginV: Math.max(0, layout.marginV + marginVShift),
    marginH: Math.max(20, layout.marginH + marginHShift),
  };
}
