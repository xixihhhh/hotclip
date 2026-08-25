/**
 * 跨批次发布账本:把已经导出的成片与后来导入的平台指标可靠地接起来。
 * 账本只保存内容元数据和本地路径,不保存平台账号、Cookie 或密钥。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PerformanceEntry, PublishLedgerItem, PerformanceMatchSummary } from "../shared/api-types";

const MAX_ITEMS = 1_000;
const ledgerPath = (userDataDir: string): string => join(userDataDir, "publish-ledger.json");

export interface RegisterPublishItem {
  filePath: string;
  title: string;
  hook?: string;
  platform: string;
  durationSec: number;
  keywords?: string[];
  exportedAt: string;
  experimentId?: string;
  variantIndex?: number;
  variantTotal?: number;
  variantRole?: "control" | "challenger";
  experimentDimensions?: Array<"packaging" | "opening">;
}

export function publishContentId(item: RegisterPublishItem): string {
  const digest = createHash("sha256")
    .update([item.filePath, item.platform, item.exportedAt].join("\0"))
    .digest("hex")
    .slice(0, 16);
  return `hc_${digest}`;
}

export function publishExperimentId(input: { sourcePath: string; platform: string; exportedAt: string; candidateId: number }): string {
  const digest = createHash("sha256")
    .update([input.sourcePath, input.platform, input.exportedAt, String(input.candidateId)].join("\0"))
    .digest("hex")
    .slice(0, 16);
  return `hcx_${digest}`;
}

function validItem(value: unknown): value is PublishLedgerItem {
  const item = value as PublishLedgerItem;
  return !!item && typeof item.contentId === "string" && typeof item.filePath === "string" &&
    typeof item.title === "string" && typeof item.platform === "string" &&
    typeof item.exportedAt === "string" && Number.isFinite(item.durationSec) &&
    (item.metricsImportedAt === undefined || typeof item.metricsImportedAt === "string") &&
    (item.experimentId === undefined || typeof item.experimentId === "string") &&
    (item.variantIndex === undefined || Number.isInteger(item.variantIndex)) &&
    (item.variantTotal === undefined || Number.isInteger(item.variantTotal)) &&
    (item.variantRole === undefined || item.variantRole === "control" || item.variantRole === "challenger") &&
    (item.experimentDimensions === undefined || (Array.isArray(item.experimentDimensions) && item.experimentDimensions.every((dimension) => dimension === "packaging" || dimension === "opening")));
}

export async function loadPublishLedger(userDataDir: string): Promise<PublishLedgerItem[]> {
  try {
    const parsed = JSON.parse(await readFile(ledgerPath(userDataDir), "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter(validItem).slice(-MAX_ITEMS) : [];
  } catch {
    return [];
  }
}

async function savePublishLedger(userDataDir: string, items: PublishLedgerItem[]): Promise<void> {
  const file = ledgerPath(userDataDir);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(items.slice(-MAX_ITEMS), null, 2), "utf8");
  await rename(tmp, file);
}

export async function registerPublishItems(userDataDir: string, incoming: RegisterPublishItem[]): Promise<PublishLedgerItem[]> {
  const byId = new Map((await loadPublishLedger(userDataDir)).map((item) => [item.contentId, item]));
  for (const input of incoming) {
    const contentId = publishContentId(input);
    byId.set(contentId, {
      ...byId.get(contentId),
      contentId,
      filePath: input.filePath,
      title: input.title.slice(0, 160),
      hook: input.hook?.slice(0, 200),
      platform: input.platform.slice(0, 40),
      durationSec: Math.max(0, input.durationSec),
      keywords: input.keywords?.slice(0, 12),
      exportedAt: input.exportedAt,
      ...(input.experimentId ? { experimentId: input.experimentId } : {}),
      ...(Number.isInteger(input.variantIndex) ? { variantIndex: input.variantIndex } : {}),
      ...(Number.isInteger(input.variantTotal) ? { variantTotal: input.variantTotal } : {}),
      ...(input.variantRole ? { variantRole: input.variantRole } : {}),
      ...(input.experimentDimensions?.length ? { experimentDimensions: [...new Set(input.experimentDimensions)].slice(0, 2) } : {}),
    });
  }
  const items = [...byId.values()].sort((a, b) => a.exportedAt.localeCompare(b.exportedAt)).slice(-MAX_ITEMS);
  await savePublishLedger(userDataDir, items);
  return items;
}

const normalizedTitle = (value: string): string => value.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g, " ");
const normalizedPlatform = (value: string): string => value.trim().toLocaleLowerCase();

export interface CorrelatedPerformance {
  entries: PerformanceEntry[];
  summary: PerformanceMatchSummary;
}

/** ID 优先;无 ID 时只接受唯一的精确标题匹配。歧义行绝不静默认领。 */
export async function correlatePerformanceEntries(
  userDataDir: string,
  entries: PerformanceEntry[],
  now = new Date().toISOString()
): Promise<CorrelatedPerformance> {
  const ledger = await loadPublishLedger(userDataDir);
  const byId = new Map(ledger.map((item) => [item.contentId, item]));
  let matched = 0;
  let unmatched = 0;
  let ambiguous = 0;
  const unmatchedTitles: string[] = [];
  const ambiguousTitles: string[] = [];
  const correlated = entries.map((entry) => {
    let item = entry.contentId ? byId.get(entry.contentId) : undefined;
    let confidence: PerformanceEntry["matchConfidence"] = item ? "id" : undefined;
    // 模板里显式带了 ID 却查不到时不能再按标题兜底:可能是另一台机器/
    // 旧账本的 ID,按标题认领会把指标挂错内容。
    if (entry.contentId && !item) {
      unmatched++;
      unmatchedTitles.push(entry.title);
      return { ...entry, matchConfidence: "unmatched" as const };
    }
    if (!item) {
      const title = normalizedTitle(entry.title);
      const platform = normalizedPlatform(entry.platform);
      const sameTitle = ledger.filter((candidate) => normalizedTitle(candidate.title) === title);
      const samePlatform = sameTitle.filter((candidate) => {
        const candidatePlatform = normalizedPlatform(candidate.platform);
        return candidatePlatform === platform || candidatePlatform === "unassigned";
      });
      const candidates = samePlatform.length > 0 ? samePlatform : sameTitle;
      if (candidates.length === 1) {
        item = candidates[0];
        confidence = samePlatform.length === 1 ? "title-platform" : "title";
      } else if (candidates.length > 1) {
        ambiguous++;
        ambiguousTitles.push(entry.title);
        return { ...entry, matchConfidence: "ambiguous" as const };
      }
    }
    if (!item) {
      unmatched++;
      unmatchedTitles.push(entry.title);
      return { ...entry, matchConfidence: "unmatched" as const };
    }
    matched++;
    item.metricsImportedAt = now;
    return { ...entry, contentId: item.contentId, matchConfidence: confidence };
  });
  if (matched > 0) await savePublishLedger(userDataDir, ledger);
  return {
    entries: correlated,
    summary: {
      matched,
      unmatched,
      ambiguous,
      unmatchedTitles: unmatchedTitles.slice(0, 8),
      ambiguousTitles: ambiguousTitles.slice(0, 8),
    },
  };
}

function csvField(value: string | number): string {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 用户只需补播放/互动列;稳定内容 ID 可避免重名标题误匹配。 */
export function buildPerformanceTemplate(items: PublishLedgerItem[]): string {
  const header = ["content_id", "title", "platform", "experiment_id", "variant", "duration_sec", "keywords", "published_at", "views", "likes", "comments", "shares", "saves"];
  const lines = [header.join(",")];
  for (const item of items) {
    lines.push([
      item.contentId,
      item.title,
      item.platform === "unassigned" ? "" : item.platform,
      item.experimentId ?? "",
      item.variantIndex ?? "",
      Number(item.durationSec.toFixed(1)),
      item.keywords?.join("|") ?? "",
      "", "", "", "", "", "",
    ].map(csvField).join(","));
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

export async function clearPublishLedger(userDataDir: string): Promise<void> {
  await rm(ledgerPath(userDataDir), { force: true });
}

/** 清表现记忆时保留导出登记,只把成片重新标回“等待数据”。 */
export async function clearPublishMetrics(userDataDir: string): Promise<void> {
  const items = (await loadPublishLedger(userDataDir)).map(({ metricsImportedAt: _ignored, ...item }) => item);
  if (items.length > 0) await savePublishLedger(userDataDir, items);
}
