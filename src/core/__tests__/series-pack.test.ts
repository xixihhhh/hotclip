import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSeriesPack, groupTopicSeries, SERIES_DIR_NAME, type SeriesClipInput } from "../series-pack";

let root = "";
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
const fresh = async (): Promise<string> => (root = await mkdtemp(join(tmpdir(), "hotclip-series-")));
const clip = (title: string, keywords: string[], sourceStartSec: number, file = `/${title}.mp4`): SeriesClipInput => ({ file, title, keywords, sourceStartSec });

describe("topic series grouping", () => {
  it("uses repeated specific keywords, excludes generic/singleton terms, and orders by source time", () => {
    const groups = groupTopicSeries([
      clip("后篇", ["直播", "省钱", "订阅"], 30),
      clip("前篇", ["省钱", "设置"], 10),
      clip("孤篇", ["摄影"], 20),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].topic).toBe("省钱");
    expect(groups[0].clips.map((item) => item.title)).toEqual(["前篇", "后篇"]);
  });

  it("assigns each clip to one strongest topic and drops post-assignment singletons", () => {
    const groups = groupTopicSeries([
      clip("A", ["效率", "剪辑"], 1),
      clip("B", ["效率"], 2),
      clip("C", ["剪辑"], 3),
    ]);
    expect(groups).toHaveLength(1);
    expect(["效率", "剪辑"]).toContain(groups[0].topic);
    expect(groups[0].clips).toHaveLength(2);
    expect(groups[0].clips.map((item) => item.title)).toContain("A");
  });
});

describe("series pack files", () => {
  it("creates ordered hard-linked episodes and manifests", async () => {
    const dir = await fresh();
    const a = join(dir, "a.mp4");
    const b = join(dir, "b.mp4");
    await writeFile(a, "a");
    await writeFile(b, "b");
    const summary = await buildSeriesPack(dir, [clip("第二集", ["教程"], 20, b), clip("第一集", ["教程"], 10, a)]);
    expect(summary).toMatchObject({ seriesCount: 1, clipCount: 2 });
    const manifest = JSON.parse(await readFile(join(dir, SERIES_DIR_NAME, "教程", "manifest.json"), "utf8"));
    expect(manifest.clips.map((item: { file: string }) => item.file)).toEqual(["01-a.mp4", "02-b.mp4"]);
    expect((await stat(a)).ino).toBe((await stat(join(dir, SERIES_DIR_NAME, "教程", "01-a.mp4"))).ino);
  });

  it("returns null and creates no directory when nothing forms a series", async () => {
    const dir = await fresh();
    expect(await buildSeriesPack(dir, [clip("单条", ["唯一"], 1)])).toBeNull();
    await expect(stat(join(dir, SERIES_DIR_NAME))).rejects.toThrow();
  });

  it("sanitizes topic directory names", async () => {
    const dir = await fresh();
    const a = join(dir, "a.mp4");
    const b = join(dir, "b.mp4");
    await writeFile(a, "a");
    await writeFile(b, "b");
    const summary = await buildSeriesPack(dir, [clip("A", ["AI/剪辑:*"], 1, a), clip("B", ["AI/剪辑:*"], 2, b)]);
    expect(summary?.series[0].dir).toBe(join(dir, SERIES_DIR_NAME, "ai剪辑"));
  });
});
