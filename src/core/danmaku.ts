/**
 * 弹幕热度信号:用弹幕密度峰值圈出"观众实时高能反应"的时段,进爆点判断——
 * 弹幕是观众逐秒投出的票,比任何模型推断都直接;中文直播切片的差异化证据。
 *
 * 两种落盘格式零配置自动发现(视频旁同名文件,谁在就读谁):
 *  - B 站格式 .xml:录播姬随录播落的,兼容主站导出;
 *  - 抖音直播录制的 .jsonl:每行一条 {type,content,recvTimeSec,...},
 *    抖音生态录制工具的通用产物——抖音主播/口播博主(正好是切片甜蜜区人群)
 *    录播旁边就是这种文件,不认它等于把这批用户的弹幕证据全丢了。
 *
 * 高能弹幕词(哈哈哈/666/草/awsl…)加权,密度阈值相对全场基线自适应——
 * 大主播弹幕海和小主播弹幕溪都能圈出各自的峰。三条防伪:
 *  - 反刷屏:同一发送者单窗贡献封顶(一个人刷一百条不算全场沸腾);
 *  - 突发加成:相对前一窗的热度跳升计入得分——爆点是"突然炸",持续温热
 *    会一起抬高基线阈值,不会被误圈;
 *  - 互动事件(SC/舰长/礼物/关注/点赞高峰):观众花真金白银或用行动投的票,
 *    按事件档加权,比普通弹幕硬。
 * 纯函数可单测。
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
/** 互动事件权重:SC/舰长一条顶一波弹幕;礼物(常见免费小礼物刷得多)只算一票;
 * 关注是明确的认可动作比弹幕硬;点赞连点时消息成串,密度本身就是信号。 */
const SC_WEIGHT = 6;
const GUARD_WEIGHT = 6;
const GIFT_WEIGHT = 1;
const FOLLOW_WEIGHT = 2;
const LIKE_WEIGHT = 1;
/**
 * 反刷屏:同一发送者在一个窗里最多贡献这么多权重(约两条高能弹幕的量)。
 * 一个人刷一百条不算全场沸腾;比"按占比打折"更硬——打折压不住极端刷屏。
 */
const SPAM_SENDER_CAP = 4;
/** 突发加成系数:相对前一窗的热度跳升按该比例计入得分。 */
const SURGE_GAIN = 0.5;

export interface DanmakuItem {
  /** 相对视频开头的秒。 */
  t: number;
  text: string;
  /** 发送者标识(uid 哈希);缺失时该条不参与刷屏判定。 */
  uid?: string;
  /** 付费事件的固定权重(SC/舰长/礼物);普通弹幕走 danmakuWeight。 */
  boost?: number;
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

/** 还原 XML 文本:剥标签 + 常见实体。 */
function xmlText(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .trim();
}

/** 从属性串里取一个属性值;没有返回空串。 */
function xmlAttr(attrs: string, name: string): string {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : "";
}

/** 解析 B 站格式弹幕 XML(<d p="秒,...">文本</d> + 录播姬扩展的 sc/gift/guard);容错,坏条目跳过。 */
export function parseBiliDanmakuXml(xml: string): DanmakuItem[] {
  const out: DanmakuItem[] = [];
  const re = /<d\s+p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g;
  for (const m of xml.matchAll(re)) {
    const parts = m[1].split(",");
    const t = Number(parts[0]);
    const text = xmlText(m[2]);
    // p 属性第 7 字段是发送者 uid 哈希(主站/录播姬都有);"0" 是占位不算
    const uid = parts[6] && parts[6] !== "0" ? parts[6] : undefined;
    if (Number.isFinite(t) && t >= 0 && text) out.push({ t, text, ...(uid ? { uid } : {}) });
  }
  // 付费事件(录播姬开"高级弹幕录制"时才有,没有就自然为空):
  // 时间取 ts 属性(视频相对秒),发送者取 uid/user——属性名做宽松兜底
  const paid = /<(sc|gift|guard)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g;
  for (const m of xml.matchAll(paid)) {
    const kind = m[1];
    const tsRaw = xmlAttr(m[2], "ts");
    if (!tsRaw) continue; // 没有时间戳的事件无法对齐时间轴,跳过
    const t = Number(tsRaw);
    if (!Number.isFinite(t) || t < 0) continue;
    const uid = xmlAttr(m[2], "uid") || xmlAttr(m[2], "user") || undefined;
    const boost = kind === "sc" ? SC_WEIGHT : kind === "guard" ? GUARD_WEIGHT : GIFT_WEIGHT;
    const text = kind === "sc" ? xmlText(m[3] ?? "") || "SC" : xmlAttr(m[2], "giftname") || kind;
    out.push({ t, text, boost, ...(uid ? { uid } : {}) });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** 相对时间的合理上限(48h):防止把纪元时间戳当相对秒,整条时间轴错位。 */
const MAX_REL_SEC = 48 * 3600;

/** 宽松取字符串字段(protobuf 的 int64 id 序列化后可能是数字)。 */
function strField(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

/**
 * 取一行消息的相对时间。字段优先级 recvTimeSec > timestamp > _time
 * (与抖音录制工具的落盘口径一致);超出合理范围的(比如纪元秒)不认——
 * 对不上时间轴的消息宁可丢弃,也不能让它落在第 0 秒污染开头。
 */
function pickTime(msg: Record<string, unknown>): number | null {
  for (const key of ["recvTimeSec", "timestamp", "_time"]) {
    const v = msg[key];
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (Number.isFinite(n) && n >= 0 && n <= MAX_REL_SEC) return n;
  }
  return null;
}

/**
 * 解析抖音直播录制的弹幕 JSONL(每行一条 JSON):chat 计弹幕、gift/social/
 * like 按互动事件档计权,member(进场)/roomStats(在线数)不是观众反应不计。
 * 容错:坏行跳过(录制进程被杀时最后一行常是半截)。纯函数。
 */
export function parseDouyinDanmakuJsonl(jsonl: string): DanmakuItem[] {
  const out: DanmakuItem[] = [];
  for (const line of jsonl.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(s) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!msg || typeof msg !== "object") continue;
    const t = pickTime(msg);
    if (t === null) continue;
    const type = strField(msg.type);
    const uid = strField(msg.userId) || strField(msg.userName) || undefined;
    if (type === "chat") {
      const text = strField(msg.content);
      if (text) out.push({ t, text, ...(uid ? { uid } : {}) });
    } else if (type === "gift") {
      out.push({ t, text: strField(msg.giftName) || "礼物", boost: GIFT_WEIGHT, ...(uid ? { uid } : {}) });
    } else if (type === "social") {
      // 关注/分享:观众用行动投票,比一条普通弹幕硬
      out.push({ t, text: "关注", boost: FOLLOW_WEIGHT, ...(uid ? { uid } : {}) });
    } else if (type === "like") {
      // 点赞连点时消息成串,密度峰本身就是"观众在拍手"
      out.push({ t, text: "点赞", boost: LIKE_WEIGHT, ...(uid ? { uid } : {}) });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** 单条弹幕权重:高能反应词翻倍。 */
export function danmakuWeight(text: string): number {
  return HYPE_RE.test(text) ? 2 : 1;
}

/** 单条权重:付费事件按固定档,普通弹幕看高能词。 */
function itemWeight(item: DanmakuItem): number {
  return item.boost ?? danmakuWeight(item.text);
}

/**
 * 密度峰值圈段:滑窗加权计数 → 反刷屏打折 → 突发加成,阈值 =
 * max(全场中位数×2.5, MIN_PEAK_WEIGHT),超阈值的窗并段;按窗得分排序
 * 截前 MAX_PEAKS,再按时间序输出。纯函数。
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
    // 反刷屏:同一发送者的贡献封顶——没有 uid 的老格式不误伤(fail-open)
    const spent = new Map<string, number>();
    for (let i = lo; i < items.length && items[i].t < end; i++) {
      const w = itemWeight(items[i]);
      const uid = items[i].uid;
      if (!uid) {
        weight += w;
        continue;
      }
      const used = spent.get(uid) ?? 0;
      const grant = Math.min(w, SPAM_SENDER_CAP - used);
      if (grant > 0) {
        weight += grant;
        spent.set(uid, used + grant);
      }
    }
    windows.push({ startSec: start, endSec: Math.min(end, durationSec), weight });
  }
  // 突发加成:相对前一窗的跳升计入得分——爆点是"突然炸";全场持续温热时
  // 各窗跳升为零、中位数阈值又随基线抬高,不会被误圈
  const scored = windows.map((w, i) => ({
    ...w,
    weight: i === 0 ? w.weight : w.weight + SURGE_GAIN * Math.max(0, w.weight - windows[i - 1].weight),
  }));
  const weights = scored.map((w) => w.weight).sort((a, b) => a - b);
  const median = weights[Math.floor(weights.length / 2)] ?? 0;
  const threshold = Math.max(median * 2.5, MIN_PEAK_WEIGHT);
  const hot = scored.filter((w) => w.weight >= threshold);
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
 * 视频旁可能的弹幕文件,按优先级:同名 .xml(录播姬)→ 同名 .jsonl →
 * {首段}_danmaku.jsonl(抖音录制工具约定:视频叫 {房间号}_merged.mp4 或
 * {房间号}_画质_时间.flv,弹幕叫 {房间号}_danmaku.jsonl)。纯函数。
 */
export function danmakuPathsFor(videoPath: string): string[] {
  const base = videoPath.replace(/\.[^./\\]+$/, "");
  const out = [base + ".xml", base + ".jsonl"];
  const m = base.match(/^(.*[/\\])?([^/\\_]+)_[^/\\]*$/);
  if (m) out.push((m[1] ?? "") + m[2] + "_danmaku.jsonl");
  return [...new Set(out)];
}

/**
 * 读视频旁的弹幕文件(按 danmakuPathsFor 优先级逐个试),解析出弹幕条目。
 * 全部落空返回 null。时间轴曲线与峰值信号共用这一个入口。
 */
export async function readDanmakuItems(videoPath: string): Promise<DanmakuItem[] | null> {
  for (const path of danmakuPathsFor(videoPath)) {
    try {
      const raw = await readFile(path, "utf8");
      const items = path.endsWith(".xml") ? parseBiliDanmakuXml(raw) : parseDouyinDanmakuJsonl(raw);
      if (items.length >= 20) return items; // 太少不成信号,试下一个候选
    } catch {
      // 该候选读不到/解析不了,试下一个
    }
  }
  return null;
}

/**
 * 弹幕热度曲线:每格加权计数(与峰值信号同一套单条权重),按全场最大值
 * 归一到 0..1——工作台时间轴用。纯函数。
 */
export function danmakuHeatCurve(items: DanmakuItem[], durationSec: number, bins: number): number[] {
  if (!(durationSec > 0) || bins < 1 || items.length === 0) return [];
  const out = new Float64Array(bins);
  for (const item of items) {
    if (item.t < 0 || item.t > durationSec) continue;
    const i = Math.min(bins - 1, Math.floor((item.t / durationSec) * bins));
    out[i] += itemWeight(item);
  }
  const max = Math.max(...out);
  if (max <= 0) return [...out];
  return [...out].map((v) => v / max);
}

/**
 * 零配置采集:读弹幕 → 圈峰。任何失败都返回 null,绝不拖垮检测。
 */
export async function collectDanmakuSignal(videoPath: string, durationSec: number): Promise<DanmakuOutcome | null> {
  const items = await readDanmakuItems(videoPath);
  if (!items) return null;
  const peaks = danmakuPeaks(items, durationSec);
  return { danmakuPeaks: peaks, stats: { count: items.length, peakCount: peaks.length } };
}
