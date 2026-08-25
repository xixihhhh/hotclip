import { describe, expect, it } from "vitest";
import type { PerformanceEntry, PublishLedgerItem } from "../../shared/api-types";
import { summarizeExperiments } from "../experiments";

const ledgerItem = (index: number, over: Partial<PublishLedgerItem> = {}): PublishLedgerItem => ({
  contentId: `hc_v${index}`,
  filePath: `/exports/v${index}.mp4`,
  title: `版本 ${index}`,
  platform: "douyin",
  durationSec: 24,
  exportedAt: "2026-08-24T08:00:00.000Z",
  experimentId: "hcx_test",
  variantIndex: index,
  variantTotal: 2,
  variantRole: index === 1 ? "control" : "challenger",
  experimentDimensions: ["packaging"],
  ...over,
});

const metric = (index: number, over: Partial<PerformanceEntry> = {}): PerformanceEntry => ({
  contentId: `hc_v${index}`,
  title: `版本 ${index}`,
  platform: "douyin",
  views: 10_000,
  likes: index === 1 ? 300 : 800,
  comments: 0,
  shares: 0,
  saves: 0,
  publishedAt: `2026-08-24T${String(8 + index).padStart(2, "0")}:00:00.000Z`,
  importedAt: "2026-08-25T08:00:00.000Z",
  matchConfidence: "id",
  ...over,
});

describe("local performance experiments", () => {
  it("reports a conservative directional lead for a complete same-platform group", () => {
    const summary = summarizeExperiments([ledgerItem(1), ledgerItem(2)], [metric(1), metric(2)]);
    expect(summary).toMatchObject({ total: 1, ready: 1, awaiting: 0, insufficient: 0 });
    expect(summary.recent[0]).toMatchObject({
      status: "directional",
      platform: "douyin",
      leaderContentId: "hc_v2",
      relativeLiftPct: 166.7,
      absoluteLiftPoints: 5,
      measuredVariants: 2,
    });
  });

  it("waits for every planned variant and all metrics", () => {
    expect(summarizeExperiments([ledgerItem(1)], [metric(1)]).recent[0].status).toBe("incomplete-group");
    expect(summarizeExperiments([ledgerItem(1), ledgerItem(2)], [metric(1)]).recent[0].status).toBe("awaiting-metrics");
  });

  it.each([
    ["ambiguous-metrics", [metric(1), metric(1, { platform: "bilibili" }), metric(2)]],
    ["platform-mismatch", [metric(1), metric(2, { platform: "bilibili" })]],
    ["missing-publish-time", [metric(1, { publishedAt: undefined }), metric(2)]],
    ["outside-window", [metric(1), metric(2, { publishedAt: "2026-08-29T09:00:00.000Z" })]],
    ["low-sample", [metric(1, { views: 499 }), metric(2)]],
    ["inconclusive", [metric(1, { likes: 300 }), metric(2, { likes: 310 })]],
  ] as const)("returns %s instead of overclaiming", (status, entries) => {
    expect(summarizeExperiments([ledgerItem(1), ledgerItem(2)], [...entries]).recent[0].status).toBe(status);
  });

  it("resolves an unassigned export only when all imported variants share one platform", () => {
    const ledger = [ledgerItem(1, { platform: "unassigned" }), ledgerItem(2, { platform: "unassigned" })];
    expect(summarizeExperiments(ledger, [metric(1, { platform: "xiaohongshu" }), metric(2, { platform: "xiaohongshu" })]).recent[0].platform).toBe("xiaohongshu");
    expect(summarizeExperiments(ledger, [metric(1), metric(2, { platform: "bilibili" })]).recent[0].status).toBe("platform-mismatch");
  });
});
