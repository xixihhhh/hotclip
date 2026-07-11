/**
 * 字幕安全区:各平台竖屏播放器 UI 会盖住画面的区域(右侧点赞/评论/分享栏、
 * 底部文案+进度区、顶部状态区)。审阅台把这些区域叠成半透明遮罩,字幕/主体
 * 压线一眼可见——防「字幕被点赞按钮挡住」这类投稿翻车。
 * 所有矩形以 9:16 成片画面的百分比表示(0-1),与分辨率无关。纯数据+纯函数。
 */

/** 一块遮挡区(相对 9:16 画面的百分比矩形)。 */
export interface SafeZoneRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlatformZones {
  id: string;
  /** 平台名(zh/en 界面各取所需)。 */
  name: { zh: string; en: string };
  zones: SafeZoneRect[];
}

// 数据基准 1080×1920,换算为百分比。TikTok/Reels/Shorts 来自设计模板的精确
// 像素(getkoro/postplanify/orsonlord);国内平台无官方规范,按实测文章与
// TikTok 同源布局近似(抖音/快手右栏竖排,视频号/小红书为上下横条无右栏,
// 视频号仅中间 6:7 区域不被遮挡)。取值宁大勿小——宁多提示,勿漏遮挡。
export const SAFE_ZONE_PLATFORMS: PlatformZones[] = [
  {
    id: "generic",
    name: { zh: "通用竖屏", en: "Generic vertical" },
    // 各平台遮挡并集:顶 13% + 底 25.2% + 右栏 14.8%(纵向 38%~88%)
    zones: [
      { x: 0, y: 0, w: 1, h: 0.13 },
      { x: 0, y: 0.748, w: 1, h: 0.252 },
      { x: 0.852, y: 0.38, w: 0.148, h: 0.5 },
    ],
  },
  {
    id: "douyin",
    name: { zh: "抖音", en: "Douyin" },
    zones: [
      { x: 0, y: 0, w: 1, h: 0.078 },
      { x: 0, y: 0.83, w: 1, h: 0.17 },
      { x: 0.87, y: 0.4, w: 0.13, h: 0.45 },
    ],
  },
  {
    id: "kuaishou",
    name: { zh: "快手", en: "Kuaishou" },
    zones: [
      { x: 0, y: 0, w: 1, h: 0.078 },
      { x: 0, y: 0.844, w: 1, h: 0.156 },
      { x: 0.88, y: 0.4, w: 0.12, h: 0.45 },
    ],
  },
  {
    id: "bilibili",
    name: { zh: "B站竖屏", en: "Bilibili story" },
    // 右栏比抖音高(多「投币」);弹幕飘过上 1/3 不可控,提示见 UI 文案
    zones: [
      { x: 0, y: 0, w: 1, h: 0.08 },
      { x: 0, y: 0.8, w: 1, h: 0.2 },
      { x: 0.87, y: 0.45, w: 0.13, h: 0.43 },
    ],
  },
  {
    id: "channels",
    name: { zh: "视频号", en: "WeChat Channels" },
    // 交互在底栏横排,无右侧竖栏;仅中间 6:7 区域(约 y 11.5%~77%)不被遮挡
    zones: [
      { x: 0, y: 0, w: 1, h: 0.115 },
      { x: 0, y: 0.771, w: 1, h: 0.229 },
    ],
  },
  {
    id: "xiaohongshu",
    name: { zh: "小红书", en: "RedNote" },
    zones: [
      { x: 0, y: 0, w: 1, h: 0.078 },
      { x: 0, y: 0.85, w: 1, h: 0.15 },
    ],
  },
  {
    id: "tiktok",
    name: { zh: "TikTok", en: "TikTok" },
    zones: [
      { x: 0, y: 0, w: 1, h: 0.068 },
      { x: 0, y: 0.748, w: 1, h: 0.252 },
      { x: 0.87, y: 0.4, w: 0.13, h: 0.45 },
    ],
  },
  {
    id: "reels",
    name: { zh: "Reels", en: "Instagram Reels" },
    zones: [
      { x: 0, y: 0, w: 1, h: 0.11 },
      { x: 0, y: 0.8, w: 1, h: 0.2 },
      { x: 0.889, y: 0.4, w: 0.111, h: 0.45 },
    ],
  },
  {
    id: "shorts",
    name: { zh: "Shorts", en: "YouTube Shorts" },
    zones: [
      { x: 0, y: 0, w: 1, h: 0.089 },
      { x: 0, y: 0.8, w: 1, h: 0.2 },
      { x: 0.89, y: 0.38, w: 0.11, h: 0.5 },
    ],
  },
];

/** 按 id 取平台;未知 id 回落第一个(通用)。 */
export function zonesFor(id: string): PlatformZones {
  return SAFE_ZONE_PLATFORMS.find((p) => p.id === id) ?? SAFE_ZONE_PLATFORMS[0];
}

/** object-contain 布局:视频(纵横比 ar)在 cw×ch 容器里的显示盒。 */
export function fitContain(cw: number, ch: number, ar: number): { x: number; y: number; w: number; h: number } {
  if (!(cw > 0) || !(ch > 0) || !(ar > 0)) return { x: 0, y: 0, w: 0, h: 0 };
  const w = Math.min(cw, ch * ar);
  const h = w / ar;
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
}

/**
 * 竖屏 9:16 中心裁切窗在显示盒内的位置(源比 9:16 宽则两侧被裁,窄则全保)。
 * 人脸跟随时裁窗会横移,这里画的是中心兜底位——提示文案里注明。
 */
export function cropRect9x16(box: { x: number; y: number; w: number; h: number }): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const targetAr = 9 / 16;
  const w = Math.min(box.w, box.h * targetAr);
  const h = w / targetAr > box.h ? box.h : w / targetAr;
  const ww = Math.min(w, h * targetAr);
  return { x: box.x + (box.w - ww) / 2, y: box.y + (box.h - h) / 2, w: ww, h };
}
