import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  clearEvidenceIndex,
  createEvidenceEntryKey,
  fingerprintEvidenceSource,
  inspectEvidenceIndex,
  pruneEvidenceIndex,
  readEvidence,
  writeEvidence,
} from "../evidence-index";
import { collectSignalsEvidence, collectVisionEvidence, detectShotBoundariesEvidence } from "../media-evidence";

let root = "";

async function fresh(): Promise<{ dir: string; sourcePath: string }> {
  root = await mkdtemp(join(tmpdir(), "hotclip-evidence-index-"));
  const sourcePath = join(root, "source.mp4");
  await writeFile(sourcePath, "source-v1");
  return { dir: join(root, "evidence"), sourcePath };
}

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

describe("evidence index lifecycle", () => {
  it("keys by exact source version and capability", async () => {
    const { sourcePath } = await fresh();
    const first = await fingerprintEvidenceSource(sourcePath);
    expect(createEvidenceEntryKey(first, "signals:v1")).not.toBe(createEvidenceEntryKey(first, "shots:v1"));
    await writeFile(sourcePath, "source-v2-longer");
    const changed = await fingerprintEvidenceSource(sourcePath);
    expect(createEvidenceEntryKey(first, "signals:v1")).not.toBe(createEvidenceEntryKey(changed, "signals:v1"));
  });

  it("atomically writes, validates, touches, and clears only evidence", async () => {
    const { dir, sourcePath } = await fresh();
    const project = join(root, "project.hotclip");
    await writeFile(project, "keep");
    const source = await fingerprintEvidenceSource(sourcePath);
    expect(await writeEvidence(dir, source, "test:v1", { ok: true })).toBe(true);
    const validator = (value: unknown): value is { ok: boolean } => !!value && typeof value === "object" && typeof (value as { ok?: unknown }).ok === "boolean";
    expect(await readEvidence(dir, source, "test:v1", validator)).toEqual({ ok: true });
    expect(await inspectEvidenceIndex(dir)).toMatchObject({ entries: 1 });
    await clearEvidenceIndex(dir);
    expect(await inspectEvidenceIndex(dir)).toEqual({ bytes: 0, entries: 0 });
    expect(await readFile(project, "utf8")).toBe("keep");
  });

  it("drops invalid entries and prunes least-recently-used JSON to the byte budget", async () => {
    const { dir, sourcePath } = await fresh();
    const source = await fingerprintEvidenceSource(sourcePath);
    await writeEvidence(dir, source, "a", { text: "a".repeat(200) });
    await writeEvidence(dir, source, "b", { text: "b".repeat(200) });
    const files = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
    await utimes(join(dir, files[0]), new Date(1_000), new Date(1_000));
    await utimes(join(dir, files[1]), new Date(2_000), new Date(2_000));
    const newestSize = (await stat(join(dir, files[1]))).size;
    expect(await pruneEvidenceIndex(dir, newestSize)).toEqual({ bytes: newestSize, entries: 1 });

    const remaining = (await readdir(dir)).find((name) => name.endsWith(".json"));
    expect(remaining).toBeTruthy();
    await writeFile(join(dir, remaining!), "not json");
    const capability = remaining === `${createEvidenceEntryKey(source, "a")}.json` ? "a" : "b";
    expect(await readEvidence(dir, source, capability, (_value): _value is unknown => true)).toBeUndefined();
  });
});

describe("capability adapters", () => {
  it("reuses Tier-0 signals and range-scoped shot boundaries", async () => {
    const { dir, sourcePath } = await fresh();
    const collect = vi.fn(async () => ({ loudPeaks: [], cutDense: [], motionPeaks: [{ startSec: 2, endSec: 4 }] }));
    const first = await collectSignalsEvidence({ videoPath: sourcePath, evidenceDir: dir, collect });
    const second = await collectSignalsEvidence({ videoPath: sourcePath, evidenceDir: dir, collect });
    expect(second).toEqual(first);
    expect(collect).toHaveBeenCalledTimes(1);

    const detect = vi.fn(async () => [1.25, 3.5]);
    expect(await detectShotBoundariesEvidence({ videoPath: sourcePath, startSec: 0, endSec: 5, modelsRoot: root, evidenceDir: dir, detect })).toEqual([1.25, 3.5]);
    expect(await detectShotBoundariesEvidence({ videoPath: sourcePath, startSec: 0, endSec: 5, modelsRoot: root, evidenceDir: dir, detect })).toEqual([1.25, 3.5]);
    expect(detect).toHaveBeenCalledTimes(1);
    await detectShotBoundariesEvidence({ videoPath: sourcePath, startSec: 1, endSec: 5, modelsRoot: root, evidenceDir: dir, detect });
    expect(detect).toHaveBeenCalledTimes(2);
  });

  it("isolates cached visual evidence by selected source picture", async () => {
    const { dir, sourcePath } = await fresh();
    const collect = vi.fn(async () => ({ loudPeaks: [], cutDense: [] }));
    await collectSignalsEvidence({
      videoPath: sourcePath,
      evidenceDir: dir,
      collect,
      analysis: { videoStreamIndex: 0 },
    });
    await collectSignalsEvidence({
      videoPath: sourcePath,
      evidenceDir: dir,
      collect,
      analysis: { videoStreamIndex: 1 },
    });
    await collectSignalsEvidence({
      videoPath: sourcePath,
      evidenceDir: dir,
      collect,
      analysis: { videoStreamIndex: 1 },
    });
    expect(collect).toHaveBeenCalledTimes(2);

    const detect = vi.fn(async () => [2]);
    const common = {
      videoPath: sourcePath,
      startSec: 0,
      endSec: 5,
      modelsRoot: root,
      evidenceDir: dir,
      detect,
    };
    await detectShotBoundariesEvidence({ ...common, analysis: { videoStreamIndex: 0 } });
    await detectShotBoundariesEvidence({ ...common, analysis: { videoStreamIndex: 1 } });
    await detectShotBoundariesEvidence({ ...common, analysis: { videoStreamIndex: 1 } });
    expect(detect).toHaveBeenCalledTimes(2);
  });

  it("reuses visual outcomes across API-key changes but not model changes", async () => {
    const { dir, sourcePath } = await fresh();
    const chat = vi.fn(async (_llm, _system, _user, _image) => JSON.stringify({
      cells: Array.from({ length: 9 }, (_, index) => ({ i: index + 1, energy: index + 1, note: `frame-${index + 1}` })),
    }));
    const common = {
      videoPath: sourcePath,
      durationSec: 300,
      evidenceDir: dir,
      composeSheet: async () => "jpeg",
      chat,
      config: { baseUrl: "http://localhost:11434/v1", model: "vision-a", apiKey: "first" },
    };
    const first = await collectVisionEvidence(common);
    const calls = chat.mock.calls.length;
    const second = await collectVisionEvidence({ ...common, config: { ...common.config, apiKey: "rotated" } });
    expect(second).toEqual(first);
    expect(chat).toHaveBeenCalledTimes(calls);
    await collectVisionEvidence({ ...common, config: { ...common.config, model: "vision-b" } });
    expect(chat.mock.calls.length).toBeGreaterThan(calls);
  });

  it("does not reuse a vision verdict for a different selected video stream", async () => {
    const { dir, sourcePath } = await fresh();
    const chat = vi.fn(async () => JSON.stringify({
      cells: Array.from({ length: 9 }, (_, index) => ({ i: index + 1, energy: 8, note: "frame" })),
    }));
    const common = {
      videoPath: sourcePath,
      durationSec: 300,
      evidenceDir: dir,
      composeSheet: async () => "jpeg",
      chat,
      config: { baseUrl: "http://localhost:11434/v1", model: "vision-a" },
    };
    await collectVisionEvidence({ ...common, analysis: { videoStreamIndex: 0 } });
    const firstCalls = chat.mock.calls.length;
    await collectVisionEvidence({ ...common, analysis: { videoStreamIndex: 1 } });
    expect(chat.mock.calls.length).toBeGreaterThan(firstCalls);
  });
});
