/**
 * Local A/B evidence derived from the publishing ledger plus imported metrics.
 * We only compare complete same-platform groups released within a tight window;
 * multi-variable packaging changes are reported as directional, never causal.
 */
import type {
  PerformanceEntry,
  PerformanceExperiment,
  PerformanceExperimentStatus,
  PerformanceSummary,
  PublishLedgerItem,
} from "../shared/api-types";

export const EXPERIMENT_MAX_PUBLISH_WINDOW_MS = 72 * 60 * 60 * 1_000;
export const EXPERIMENT_MIN_VIEWS = 500;
export const EXPERIMENT_MIN_RELATIVE_LIFT_PCT = 15;
export const EXPERIMENT_MIN_ABSOLUTE_LIFT_POINTS = 0.25;

const normalizedPlatform = (value: string): string => value.trim().toLocaleLowerCase();

function weightedEngagementRate(entry: PerformanceEntry): number {
  const weighted = entry.likes + entry.comments * 2 + entry.shares * 3 + entry.saves * 3;
  return (weighted / Math.max(1, entry.views)) * 100;
}

function comparisonStatus(
  items: PublishLedgerItem[],
  metricsByContentId: Map<string, PerformanceEntry[]>,
  expected: number
): { status: PerformanceExperimentStatus; platform: string; metrics: Map<string, PerformanceEntry> } {
  const metrics = new Map<string, PerformanceEntry>();
  const indexes = new Set(items.map((item) => item.variantIndex));
  if (indexes.size < expected) return { status: "incomplete-group", platform: items[0].platform, metrics };
  for (const item of items) {
    const candidates = metricsByContentId.get(item.contentId) ?? [];
    if (candidates.length === 0) return { status: "awaiting-metrics", platform: items[0].platform, metrics };
    if (candidates.length > 1) return { status: "ambiguous-metrics", platform: items[0].platform, metrics };
    metrics.set(item.contentId, candidates[0]);
  }
  const ledgerPlatform = normalizedPlatform(items[0].platform);
  const metricPlatforms = new Set([...metrics.values()].map((entry) => normalizedPlatform(entry.platform)));
  if ((ledgerPlatform !== "unassigned" && [...metricPlatforms].some((platform) => platform !== ledgerPlatform)) || metricPlatforms.size !== 1) {
    return { status: "platform-mismatch", platform: items[0].platform, metrics };
  }
  const platform = ledgerPlatform === "unassigned" ? [...metricPlatforms][0] : items[0].platform;
  const published = [...metrics.values()].map((entry) => entry.publishedAt ? Date.parse(entry.publishedAt) : Number.NaN);
  if (published.some((value) => !Number.isFinite(value))) return { status: "missing-publish-time", platform, metrics };
  if (Math.max(...published) - Math.min(...published) > EXPERIMENT_MAX_PUBLISH_WINDOW_MS) return { status: "outside-window", platform, metrics };
  if ([...metrics.values()].some((entry) => entry.views < EXPERIMENT_MIN_VIEWS)) return { status: "low-sample", platform, metrics };
  return { status: "inconclusive", platform, metrics };
}

export function summarizeExperiments(ledger: PublishLedgerItem[], entries: PerformanceEntry[]): PerformanceSummary["experiments"] {
  const groups = new Map<string, PublishLedgerItem[]>();
  for (const item of ledger) {
    if (!item.experimentId || !Number.isInteger(item.variantIndex) || !Number.isInteger(item.variantTotal) || (item.variantTotal ?? 0) < 2) continue;
    const list = groups.get(item.experimentId) ?? [];
    list.push(item);
    groups.set(item.experimentId, list);
  }
  const metricsByContentId = new Map<string, PerformanceEntry[]>();
  for (const entry of entries) {
    if (!entry.contentId || entry.matchConfidence === "ambiguous" || entry.matchConfidence === "unmatched") continue;
    const list = metricsByContentId.get(entry.contentId) ?? [];
    list.push(entry);
    metricsByContentId.set(entry.contentId, list);
  }

  const experiments: PerformanceExperiment[] = [];
  for (const [experimentId, rawItems] of groups) {
    const items = [...rawItems].sort((a, b) => (a.variantIndex ?? 0) - (b.variantIndex ?? 0));
    const expected = Math.max(...items.map((item) => item.variantTotal ?? 0));
    const comparison = comparisonStatus(items, metricsByContentId, expected);
    let status = comparison.status;
    let leaderContentId: string | undefined;
    let relativeLiftPct: number | undefined;
    let absoluteLiftPoints: number | undefined;
    if (status === "inconclusive") {
      const ranked = items
        .map((item) => ({ item, rate: weightedEngagementRate(comparison.metrics.get(item.contentId)!) }))
        .sort((a, b) => b.rate - a.rate);
      const leader = ranked[0];
      const runner = ranked[1];
      absoluteLiftPoints = leader.rate - runner.rate;
      relativeLiftPct = (absoluteLiftPoints / Math.max(0.1, runner.rate)) * 100;
      if (absoluteLiftPoints >= EXPERIMENT_MIN_ABSOLUTE_LIFT_POINTS && relativeLiftPct >= EXPERIMENT_MIN_RELATIVE_LIFT_PCT) {
        status = "directional";
        leaderContentId = leader.item.contentId;
      }
    }
    experiments.push({
      experimentId,
      platform: comparison.platform,
      dimensions: [...new Set(items.flatMap((item) => item.experimentDimensions ?? ["packaging" as const]))],
      variantTotal: expected,
      measuredVariants: items.filter((item) => comparison.metrics.has(item.contentId)).length,
      status,
      createdAt: items.reduce((earliest, item) => item.exportedAt < earliest ? item.exportedAt : earliest, items[0].exportedAt),
      ...(leaderContentId ? { leaderContentId } : {}),
      ...(relativeLiftPct !== undefined ? { relativeLiftPct: Number(relativeLiftPct.toFixed(1)) } : {}),
      ...(absoluteLiftPoints !== undefined ? { absoluteLiftPoints: Number(absoluteLiftPoints.toFixed(2)) } : {}),
      variants: items.map((item) => {
        const metric = comparison.metrics.get(item.contentId);
        return {
          contentId: item.contentId,
          title: item.title,
          index: item.variantIndex ?? 1,
          role: item.variantRole ?? (item.variantIndex === 1 ? "control" : "challenger"),
          ...(metric ? {
            views: metric.views,
            weightedEngagementRate: Number(weightedEngagementRate(metric).toFixed(2)),
            ...(metric.publishedAt ? { publishedAt: metric.publishedAt } : {}),
          } : {}),
        };
      }),
    });
  }
  experiments.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return {
    total: experiments.length,
    ready: experiments.filter((experiment) => experiment.status === "directional" || experiment.status === "inconclusive").length,
    awaiting: experiments.filter((experiment) => experiment.status === "awaiting-metrics").length,
    insufficient: experiments.filter((experiment) => !["directional", "inconclusive", "awaiting-metrics"].includes(experiment.status)).length,
    recent: experiments.slice(0, 12),
  };
}
