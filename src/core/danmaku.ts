/**
 * 弹幕热度信号:解析 B 站格式弹幕 XML(录播姬随录播落的同名 .xml,兼容
 * 主站导出),用弹幕密度峰值圈出"观众实时高能反应"的时段,进爆点判断——
 * 弹幕是观众逐秒投出的票,比任何模型推断都直接;中文直播切片的差异化证据。
 *
 * 零配置:检测时自动找视频旁的同名 .xml,没有就当无此信号(fail-open)。
 * 高能弹幕词(哈哈哈/666/草/awsl…)加权,密度阈值相对全场基线自适应——
 * 大主播弹幕海和小主播弹幕溪都能圈出各自的峰。纯函数可单测。
 */
import { readFile } from "fs/promises";
import type { TimeRange } from "./signals";

/** 观众高能反应词(命中一次权重翻倍)。 */
const HYPE_RE = /哈哈|233|666|hhh|草+$|艹|www|泪目|awsl|牛[逼比bB]|离谱|绷不住|笑死|卧槽|[?!?!]{3,}/i;

/** 滑动窗口宽度与步长(秒)。 */
export const DANMAKU_WINDOW_SEC = 10;
export const DANMAKU_HOP_SEC = 5;
/** 峰值窗至少要有的加权弹幕量(过滤冷场直播的伪峰)。 */
const MIN_PEAK_WEIGHT = 8;
/** 相邻峰值窗间隔小于该值时并成一段。 */
const MERGE_GAP_SEC = 12;
/** 全片圈出的时段上限(提示词别塞爆)。 */
const MAX_PEAKS = 12;

export interface DanmakuItem {
  /** 相对视频开头的秒。 */
  t: number;
  text: string;
}

export interface DanmakuStats {
  /** 解析出的弹幕条数。 */
  count: number;
  peakCount: number;
}

export interface DanmakuOutcome {
  danmakuPeaks: TimeRange[];
  stats: DanmakuStats;
}

/** 解析 B 站格式弹幕 XML(<d p="秒,...">文本</d>);容错,坏条目跳过。 */
export function parseBiliDanmakuXml(xml: string): DanmakuItem[] {
  const out: DanmakuItem[] = [];
  const re = /<d\s+p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g;
  for (const m of xml.matchAll(re)) {
    const t = Number(m[1].split(",")[0]);
    const text = m[2]
      .replace(/<[^>]+>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .trim();
    if (Number.isFinite(t) && t >= 0 && text) out.push({ t, text });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** 单条弹幕权重:高能反应词翻倍。 */
export function danmakuWeight(text: string): number {
  return HYPE_RE.test(text) ? 2 : 1;
}

/**
 * 密度峰值圈段:滑窗加权计数,阈值 = max(全场中位数×2.5, MIN_PEAK_WEIGHT),
 * 超阈值的窗并段;按窗权重排序截前 MAX_PEAKS,再按时间序输出。纯函数。
 */
export function danmakuPeaks(
  items: DanmakuItem[],
  durationSec: number,
  windowSec = DANMAKU_WINDOW_SEC,
  hopSec = DANMAKU_HOP_SEC
): TimeRange[] {
  if (items.length === 0 || !(durationSec > windowSec)) return [];
  const windows: Array<{ startSec: number; endSec: number; weight: number }> = [];
  let lo = 0;
  for (let start = 0; start + windowSec <= durationSec + hopSec; start += hopSec) {
    const end = start + windowSec;
    while (lo < items.length && items[lo].t < start) lo++;
    let weight = 0;
    for (let i = lo; i < items.length && items[i].t < end; i++) weight += danmakuWeight(items[i].text);
    windows.push({ startSec: start, endSec: Math.min(end, durationSec), weight });
  }
  const weights = windows.map((w) => w.weight).sort((a, b) => a - b);
  const median = weights[Math.floor(weights.length / 2)] ?? 0;
  const threshold = Math.max(median * 2.5, MIN_PEAK_WEIGHT);
  const hot = windows.filter((w) => w.weight >= threshold);
  if (hot.length === 0) return [];
  // 并段(记住每段的最大窗权重,截断时保住最热的段)
  const merged: Array<TimeRange & { weight: number }> = [];
  for (const w of hot) {
    const last = merged[merged.length - 1];
    if (last && w.startSec - last.endSec < MERGE_GAP_SEC) {
      last.endSec = Math.max(last.endSec, w.endSec);
      last.weight = Math.max(last.weight, w.weight);
    } else {
      merged.push({ startSec: w.startSec, endSec: w.endSec, weight: w.weight });
    }
  }
  return merged
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_PEAKS)
    .sort((a, b) => a.startSec - b.startSec)
    .map(({ startSec, endSec }) => ({ startSec, endSec }));
}

/** 视频旁同名 .xml 的路径(录播姬约定)。 */
export function danmakuPathFor(videoPath: string): string {
  return videoPath.replace(/\.[^./\\]+$/, "") + ".xml";
}

/**
 * 零配置采集:读视频旁同名 .xml → 解析 → 圈峰。任何失败(没文件/不是
 * 弹幕 XML/太少)都返回 null,绝不拖垮检测。
 */
export async function collectDanmakuSignal(videoPath: string, durationSec: number): Promise<DanmakuOutcome | null> {
  try {
    const xml = await readFile(danmakuPathFor(videoPath), "utf8");
    const items = parseBiliDanmakuXml(xml);
    if (items.length < 20) return null; // 太少不成信号
    const peaks = danmakuPeaks(items, durationSec);
    return { danmakuPeaks: peaks, stats: { count: items.length, peakCount: peaks.length } };
  } catch {
    return null;
  }
}
