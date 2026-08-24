/**
 * 发布表现反馈回路:从平台导出的 CSV/JSON 导入真实播放与互动数据,本地持久化,
 * 下一轮找爆点时把强/弱样例注入提示词。与 review-memory 的主观采用/否决
 * 互补:前者回答「我喜欢什么」,这里回答「观众真的看了什么」。
 */
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { basename, dirname, extname, join } from "path";

export interface PerformanceEntry {
  /** 平台视频 id;没有时用标题参与去重。 */
  id?: string;
  title: string;
  hook?: string;
  platform: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  durationSec?: number;
  keywords?: string[];
  publishedAt?: string;
  importedAt: string;
}

export interface PerformanceImportResult {
  imported: number;
  skipped: number;
  total: number;
  entries: PerformanceEntry[];
}

const MAX_ENTRIES = 500;
const MAX_PROMPT_EXAMPLES = 5;
const memoryPath = (userDataDir: string): string => join(userDataDir, "performance-memory.json");

const FIELD_ALIASES = {
  id: ["id", "video_id", "bvid", "aweme_id", "作品id", "视频id"],
  title: ["title", "name", "video_title", "标题", "作品标题", "视频标题"],
  hook: ["hook", "opening_hook", "钩子", "开场钩子"],
  platform: ["platform", "source", "平台"],
  views: ["views", "view", "plays", "play", "播放", "播放量", "观看量"],
  likes: ["likes", "like", "点赞", "点赞量"],
  comments: ["comments", "comment", "评论", "评论量"],
  shares: ["shares", "share", "转发", "分享", "分享量"],
  saves: ["saves", "save", "favorites", "favs", "收藏", "收藏量"],
  durationSec: ["duration_sec", "duration", "时长", "时长秒"],
  keywords: ["keywords", "tags", "关键词", "标签"],
  publishedAt: ["published_at", "publish_time", "date", "发布时间", "发布日期"],
} as const;

type Row = Record<string, unknown>;

const normalizedRow = (row: Row): Map<string, unknown> =>
  new Map(Object.entries(row).map(([k, v]) => [k.trim().toLowerCase(), v]));

function field(row: Map<string, unknown>, aliases: readonly string[]): unknown {
  for (const alias of aliases) {
    const value = row.get(alias.toLowerCase());
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return undefined;
}

/** 平台导出常见的 `1.2万` / `3,456` / `7.8k` 都可读。 */
export function metricNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? Math.max(0, value) : 0;
  const raw = String(value ?? "").trim().toLowerCase().replace(/,/g, "");
  if (!raw) return 0;
  const m = raw.match(/^(-?\d+(?:\.\d+)?)\s*(万|亿|k|m)?/i);
  if (!m) return 0;
  const base = Math.max(0, Number(m[1]));
  const mul = { 万: 10_000, 亿: 100_000_000, k: 1_000, m: 1_000_000 }[m[2] ?? ""] ?? 1;
  return Math.round(base * mul);
}

/** RFC4180 子集:支持引号、逗号、CRLF 与引号内换行。 */
export function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((v) => v.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((v) => v.trim() !== "")) rows.push(row);
  const headers = (rows.shift() ?? []).map((h, i) => (i === 0 ? h.replace(/^\uFEFF/, "") : h).trim());
  return rows.map((values) => Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ""])));
}

function keywords(value: unknown): string[] | undefined {
  const values = Array.isArray(value) ? value : String(value ?? "").split(/[#,，、;；|]/);
  const out = values.map((v) => String(v).trim()).filter(Boolean).slice(0, 12);
  return out.length > 0 ? out : undefined;
}

export function normalizePerformanceRows(rows: Row[], defaultPlatform = "unknown", now = new Date().toISOString()): {
  entries: PerformanceEntry[];
  skipped: number;
} {
  const entries: PerformanceEntry[] = [];
  let skipped = 0;
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") {
      skipped++;
      continue;
    }
    const row = normalizedRow(raw);
    const title = String(field(row, FIELD_ALIASES.title) ?? "").trim();
    const views = metricNumber(field(row, FIELD_ALIASES.views));
    if (!title || views <= 0) {
      skipped++;
      continue;
    }
    const duration = metricNumber(field(row, FIELD_ALIASES.durationSec));
    entries.push({
      id: String(field(row, FIELD_ALIASES.id) ?? "").trim() || undefined,
      title: title.slice(0, 160),
      hook: String(field(row, FIELD_ALIASES.hook) ?? "").trim().slice(0, 200) || undefined,
      platform: String(field(row, FIELD_ALIASES.platform) ?? defaultPlatform).trim().slice(0, 40) || defaultPlatform,
      views,
      likes: metricNumber(field(row, FIELD_ALIASES.likes)),
      comments: metricNumber(field(row, FIELD_ALIASES.comments)),
      shares: metricNumber(field(row, FIELD_ALIASES.shares)),
      saves: metricNumber(field(row, FIELD_ALIASES.saves)),
      durationSec: duration > 0 ? duration : undefined,
      keywords: keywords(field(row, FIELD_ALIASES.keywords)),
      publishedAt: String(field(row, FIELD_ALIASES.publishedAt) ?? "").trim().slice(0, 40) || undefined,
      importedAt: now,
    });
  }
  return { entries, skipped };
}

export async function loadPerformanceMemory(userDataDir: string): Promise<PerformanceEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(memoryPath(userDataDir), "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is PerformanceEntry =>
        !!e && typeof (e as PerformanceEntry).title === "string" &&
        typeof (e as PerformanceEntry).platform === "string" &&
        Number.isFinite((e as PerformanceEntry).views) && (e as PerformanceEntry).views > 0
    );
  } catch {
    return [];
  }
}

const entryKey = (e: PerformanceEntry): string =>
  `${e.platform.toLowerCase()}\0${(e.id || e.title).trim().toLowerCase()}`;

export async function savePerformanceMemory(userDataDir: string, incoming: PerformanceEntry[]): Promise<PerformanceEntry[]> {
  const byKey = new Map<string, PerformanceEntry>();
  for (const entry of [...(await loadPerformanceMemory(userDataDir)), ...incoming]) byKey.set(entryKey(entry), entry);
  const all = [...byKey.values()].slice(-MAX_ENTRIES);
  const file = memoryPath(userDataDir);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(all, null, 2), "utf8");
  await rename(tmp, file);
  return all;
}

export async function importPerformanceFile(userDataDir: string, inputPath: string): Promise<PerformanceImportResult> {
  const text = await readFile(inputPath, "utf8");
  const ext = extname(inputPath).toLowerCase();
  let rows: Row[];
  if (ext === ".csv") rows = parseCsv(text);
  else {
    const parsed = JSON.parse(text) as unknown;
    const value = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object"
        ? ((parsed as { data?: unknown; items?: unknown; videos?: unknown }).data ??
          (parsed as { items?: unknown }).items ?? (parsed as { videos?: unknown }).videos)
        : null;
    if (!Array.isArray(value)) throw new Error("JSON 需要是数组,或包含 data/items/videos 数组");
    rows = value as Row[];
  }
  const defaultPlatform = basename(inputPath, ext).split(/[-_.]/)[0] || "unknown";
  const normalized = normalizePerformanceRows(rows, defaultPlatform);
  const entries = await savePerformanceMemory(userDataDir, normalized.entries);
  return { imported: normalized.entries.length, skipped: normalized.skipped, total: entries.length, entries };
}

/**
 * 互动质量分:分享/收藏权重高于轻互动,并用 200 播放先验抑制小样本虚高;
 * 对播放量加很轻的对数项,避免只奖励互动率而忽略真实触达。
 */
export function performanceScore(e: PerformanceEntry): number {
  const weighted = e.likes + e.comments * 2 + e.shares * 3 + e.saves * 3;
  return (weighted / (e.views + 200)) * 1000 + Math.log10(e.views + 1) * 8;
}

export function performanceExamples(entries: PerformanceEntry[]): { winners: PerformanceEntry[]; laggards: PerformanceEntry[] } {
  const sorted = [...entries].sort((a, b) => performanceScore(b) - performanceScore(a));
  // Small imports still need contrast: reserve the lower half for laggards.
  const winnerCount = Math.min(MAX_PROMPT_EXAMPLES, Math.max(1, Math.floor(sorted.length / 2)));
  const winners = sorted.slice(0, winnerCount);
  const winnerKeys = new Set(winners.map(entryKey));
  const laggards = sorted.length < 4
    ? []
    : [...sorted].reverse().filter((e) => !winnerKeys.has(entryKey(e))).slice(0, MAX_PROMPT_EXAMPLES);
  return { winners, laggards };
}

const compactMetric = (n: number, zh: boolean): string => {
  if (zh) return n >= 100_000_000 ? `${(n / 100_000_000).toFixed(1)}亿` : n >= 10_000 ? `${(n / 10_000).toFixed(1)}万` : String(n);
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : String(n);
};

const exampleLine = (e: PerformanceEntry, zh: boolean): string => {
  const engagement = e.likes + e.comments + e.shares + e.saves;
  const rate = ((engagement / Math.max(1, e.views)) * 100).toFixed(2);
  const extra = [
    e.hook ? (zh ? `钩子「${e.hook}」` : `hook "${e.hook}"`) : "",
    e.durationSec ? `${Math.round(e.durationSec)}s` : "",
    e.keywords?.slice(0, 4).join(zh ? "、" : ", ") ?? "",
  ]
    .filter(Boolean).join(zh ? "," : ", ");
  return zh
    ? `- [${e.platform}]《${e.title}》播放 ${compactMetric(e.views, true)},总互动率 ${rate}%${extra ? `,${extra}` : ""}`
    : `- [${e.platform}] "${e.title}" ${compactMetric(e.views, false)} views, ${rate}% total engagement${extra ? `, ${extra}` : ""}`;
};

/** 只把聚合后的有限样例送给 LLM,不携带账号 cookie/目录等敏感信息。 */
export function performanceMemorySection(entries: PerformanceEntry[], zh: boolean): string {
  const { winners, laggards } = performanceExamples(entries);
  if (winners.length === 0) return "";
  if (zh) {
    let out = `\n\n【真实发布表现】(来自用户本机导入的平台数据。请总结题材/钩子/时长的共性,把它当趋势证据而非硬规则;不要照抄历史标题。)\n高表现样例(同类优先):\n${winners.map((e) => exampleLine(e, true)).join("\n")}`;
    if (laggards.length > 0) out += `\n低表现样例(同类谨慎):\n${laggards.map((e) => exampleLine(e, true)).join("\n")}`;
    return out;
  }
  let out = `\n\n[Real post performance] (locally imported platform data. Generalize topic/hook/duration patterns as trend evidence, not hard rules; never copy old titles.)\nHigh performers (prefer similar):\n${winners.map((e) => exampleLine(e, false)).join("\n")}`;
  if (laggards.length > 0) out += `\nLow performers (be cautious with similar):\n${laggards.map((e) => exampleLine(e, false)).join("\n")}`;
  return out;
}

export function performanceReport(entries: PerformanceEntry[], zh = true): string {
  if (entries.length === 0) return zh ? "还没有发布表现数据。" : "No post-performance data yet.";
  const { winners, laggards } = performanceExamples(entries);
  const platforms = [...new Set(entries.map((e) => e.platform))].join(", ");
  const lines = zh
    ? [`已学习 ${entries.length} 条发布记录 · 平台: ${platforms}`, "", "高表现:", ...winners.map((e) => exampleLine(e, true))]
    : [`Learned from ${entries.length} posts · Platforms: ${platforms}`, "", "High performers:", ...winners.map((e) => exampleLine(e, false))];
  if (laggards.length > 0) lines.push("", zh ? "低表现:" : "Low performers:", ...laggards.map((e) => exampleLine(e, zh)));
  return lines.join("\n");
}
