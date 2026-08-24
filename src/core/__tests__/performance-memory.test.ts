import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  importPerformanceFile,
  loadPerformanceMemory,
  metricNumber,
  normalizePerformanceRows,
  parseCsv,
  performanceExamples,
  performanceMemorySection,
  savePerformanceMemory,
  type PerformanceEntry,
} from "../performance-memory";
import { highlightSystemPrompt } from "../highlight/prompt";
import type { Transcript } from "../transcribe/types";

let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
const freshDir = async (): Promise<string> => (root = await mkdtemp(join(tmpdir(), "hotclip-perf-")));
const entry = (title: string, views: number, likes: number): PerformanceEntry => ({
  title, platform: "bilibili", views, likes, comments: 0, shares: 0, saves: 0,
  importedAt: "2026-08-24T00:00:00.000Z",
});

describe("performance metric import", () => {
  it("parses localized compact numbers", () => {
    expect(metricNumber("1.2万")).toBe(12_000);
    expect(metricNumber("3,456")).toBe(3_456);
    expect(metricNumber("7.8k")).toBe(7_800);
  });

  it("parses quoted CSV and Chinese field aliases", () => {
    const rows = parseCsv('标题,播放量,点赞,标签\r\n"逗号,也在标题里",1.2万,600,"效率,工具"\r\n');
    const result = normalizePerformanceRows(rows, "bilibili", "now");
    expect(result.skipped).toBe(0);
    expect(result.entries[0]).toMatchObject({ title: "逗号,也在标题里", views: 12_000, likes: 600, keywords: ["效率", "工具"] });
  });

  it("skips rows without title or positive views", () => {
    const out = normalizePerformanceRows([{ title: "", views: 10 }, { title: "无播放", views: 0 }]);
    expect(out).toEqual({ entries: [], skipped: 2 });
  });

  it("imports JSON, merges by platform/id, and survives reload", async () => {
    const dir = await freshDir();
    const file = join(dir, "bilibili.json");
    await writeFile(file, JSON.stringify([{ id: "BV1", title: "第一版", views: 100, likes: 3 }]), "utf8");
    expect((await importPerformanceFile(dir, file)).imported).toBe(1);
    await writeFile(file, JSON.stringify([{ id: "BV1", title: "更新标题", views: 200, likes: 20 }]), "utf8");
    const result = await importPerformanceFile(dir, file);
    expect(result.total).toBe(1);
    expect((await loadPerformanceMemory(dir))[0]).toMatchObject({ title: "更新标题", views: 200 });
  });
});

describe("performance prompt feedback", () => {
  it("ranks high-quality outcomes and includes winners/laggards", async () => {
    const rows = [entry("弱片", 10_000, 5), entry("强片", 10_000, 900), entry("中1", 1000, 20), entry("中2", 2000, 30)];
    const examples = performanceExamples(rows);
    expect(examples.winners[0].title).toBe("强片");
    expect(examples.laggards.map((e) => e.title)).toContain("弱片");
    const prompt = performanceMemorySection(rows, true);
    expect(prompt).toContain("【真实发布表现】");
    expect(prompt).toContain("高表现样例");
    expect(prompt).toContain("低表现样例");
    const dir = await freshDir();
    await savePerformanceMemory(dir, rows);
    expect(await loadPerformanceMemory(dir)).toHaveLength(4);
  });

  it("is wired into the highlight system prompt", () => {
    const transcript: Transcript = {
      language: "zh",
      durationSec: 10,
      segments: [{ id: 1, startSec: 0, endSec: 10, text: "这是一次完整的产品实测。" }],
    } as Transcript;
    const rows = [entry("实测强片", 20_000, 1_000)];
    expect(highlightSystemPrompt(transcript, "standard", [], undefined, undefined, undefined, undefined, rows))
      .toContain("【真实发布表现】");
  });
});
