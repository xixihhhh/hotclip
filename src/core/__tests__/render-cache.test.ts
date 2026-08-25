import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, stat, utimes, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  clearRenderCache,
  createRenderCacheKey,
  fingerprintRenderFile,
  inspectRenderCache,
  pruneRenderCache,
  restoreRenderCache,
  storeRenderCache,
} from "../render-cache";
import { rm } from "fs/promises";

let root = "";

async function freshRoot(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), "hotclip-render-cache-test-"));
  return root;
}

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

describe("render cache identity", () => {
  it("is stable across object key order and changes with semantic input", () => {
    expect(createRenderCacheKey({ source: "a", options: { crf: 18, vertical: false } })).toBe(
      createRenderCacheKey({ options: { vertical: false, crf: 18 }, source: "a" })
    );
    expect(createRenderCacheKey({ source: "a", crf: 18 })).not.toBe(
      createRenderCacheKey({ source: "a", crf: 20 })
    );
  });

  it("source size/mtime fingerprint invalidates after a file changes", async () => {
    const dir = await freshRoot();
    const source = join(dir, "source.mp4");
    await writeFile(source, "first");
    const before = await fingerprintRenderFile(source);
    await writeFile(source, "a different payload");
    const after = await fingerprintRenderFile(source);
    expect(createRenderCacheKey(before)).not.toBe(createRenderCacheKey(after));
  });
});

describe("render cache lifecycle", () => {
  it("atomically stores and restores an independent working copy", async () => {
    const dir = await freshRoot();
    const cache = join(dir, "cache");
    const source = join(dir, "source.mp4");
    const output = join(dir, "output.mp4");
    await writeFile(source, "completed-base-render");
    await storeRenderCache(cache, "abc", source);

    expect(await restoreRenderCache(cache, "abc", output)).toBe(true);
    expect(await readFile(output, "utf8")).toBe("completed-base-render");
    await writeFile(output, "later-pass-overwrite");
    expect(await restoreRenderCache(cache, "abc", output)).toBe(true);
    expect(await readFile(output, "utf8")).toBe("completed-base-render");
    expect(await inspectRenderCache(cache)).toEqual({ bytes: 21, entries: 1 });
  });

  it("rejects zero-byte entries and removes interrupted temp files", async () => {
    const dir = await freshRoot();
    const cache = join(dir, "cache");
    await writeFile(join(dir, "placeholder"), "x");
    await storeRenderCache(cache, "seed", join(dir, "placeholder"));
    await writeFile(join(cache, "empty.mp4"), "");
    const partial = join(cache, "seed.mp4.tmp-interrupted");
    await writeFile(partial, "partial");
    await utimes(partial, new Date(0), new Date(0));

    expect(await restoreRenderCache(cache, "empty", join(dir, "out.mp4"))).toBe(false);
    await pruneRenderCache(cache);
    await expect(stat(partial)).rejects.toThrow();
  });

  it("prunes least-recently-used entries to the byte budget", async () => {
    const dir = await freshRoot();
    const cache = join(dir, "cache");
    const sourceA = join(dir, "a.mp4");
    const sourceB = join(dir, "b.mp4");
    await writeFile(sourceA, "1234567890");
    await writeFile(sourceB, "abcdefghij");
    await storeRenderCache(cache, "a", sourceA);
    await storeRenderCache(cache, "b", sourceB);
    await utimes(join(cache, "a.mp4"), new Date(1_000), new Date(1_000));
    await utimes(join(cache, "b.mp4"), new Date(2_000), new Date(2_000));

    expect(await pruneRenderCache(cache, 10)).toEqual({ bytes: 10, entries: 1 });
    expect(await restoreRenderCache(cache, "a", join(dir, "old.mp4"))).toBe(false);
    expect(await restoreRenderCache(cache, "b", join(dir, "new.mp4"))).toBe(true);
  });

  it("clear removes only the render-cache directory contents", async () => {
    const dir = await freshRoot();
    const cache = join(dir, "render-cache");
    const project = join(dir, "project.hotclip");
    const source = join(dir, "source.mp4");
    await writeFile(source, "render");
    await writeFile(project, "keep");
    await storeRenderCache(cache, "a", source);

    await clearRenderCache(cache);
    expect(await inspectRenderCache(cache)).toEqual({ bytes: 0, entries: 0 });
    expect(await readFile(project, "utf8")).toBe("keep");
  });
});
