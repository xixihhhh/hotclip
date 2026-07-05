import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readdir, utimes } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  transcriptCacheFilename,
  readTranscriptCache,
  writeTranscriptCache,
  pruneCache,
  TRANSCRIPT_CACHE_VERSION,
} from "../transcribe/cache";
import type { Transcript } from "../../shared/api-types";

const T: Transcript = {
  language: "zh",
  engine: "sensevoice",
  durationSec: 3,
  segments: [{ id: 1, startSec: 0, endSec: 3, text: "你好世界", words: [{ text: "你好", startSec: 0, endSec: 1.5 }] }],
};

describe("transcriptCacheFilename", () => {
  it("is deterministic and carries the version tag", () => {
    const a = transcriptCacheFilename("/a/b.mp4", 100, 1234.7, "sensevoice");
    const b = transcriptCacheFilename("/a/b.mp4", 100, 1234.7, "sensevoice");
    expect(a).toBe(b);
    expect(a.endsWith(`_v${TRANSCRIPT_CACHE_VERSION}.json`)).toBe(true);
    expect(a).toContain("_sensevoice_100_1235_"); // mtime rounded
  });

  it("changes when file size, mtime, engine, or path changes", () => {
    const base = transcriptCacheFilename("/a/b.mp4", 100, 1000, "sensevoice");
    expect(transcriptCacheFilename("/a/b.mp4", 101, 1000, "sensevoice")).not.toBe(base);
    expect(transcriptCacheFilename("/a/b.mp4", 100, 2000, "sensevoice")).not.toBe(base);
    expect(transcriptCacheFilename("/a/b.mp4", 100, 1000, "elevenlabs")).not.toBe(base);
    expect(transcriptCacheFilename("/a/c.mp4", 100, 1000, "sensevoice")).not.toBe(base);
  });

  it("sanitizes odd engine ids to a safe filename token", () => {
    const name = transcriptCacheFilename("/a/b.mp4", 1, 1, "Eleven Labs/v2");
    expect(name).toContain("_elevenlabsv2_");
  });
});

describe("read/write round-trip", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "hotclip-cache-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes then reads the same transcript back", async () => {
    const st = { size: 500, mtimeMs: 42 };
    await writeTranscriptCache(dir, "/v/podcast.mp4", st, "sensevoice", T);
    const got = await readTranscriptCache(dir, "/v/podcast.mp4", st, "sensevoice");
    expect(got?.segments[0].text).toBe("你好世界");
  });

  it("misses when the engine differs (different transcript)", async () => {
    const st = { size: 500, mtimeMs: 42 };
    await writeTranscriptCache(dir, "/v/podcast.mp4", st, "sensevoice", T);
    expect(await readTranscriptCache(dir, "/v/podcast.mp4", st, "paraformer")).toBeUndefined();
  });

  it("misses when the file changed (mtime/size)", async () => {
    await writeTranscriptCache(dir, "/v/podcast.mp4", { size: 500, mtimeMs: 42 }, "sensevoice", T);
    expect(await readTranscriptCache(dir, "/v/podcast.mp4", { size: 500, mtimeMs: 99 }, "sensevoice")).toBeUndefined();
    expect(await readTranscriptCache(dir, "/v/podcast.mp4", { size: 999, mtimeMs: 42 }, "sensevoice")).toBeUndefined();
  });

  it("fails open on a missing dir and on corrupt JSON", async () => {
    expect(await readTranscriptCache("/no/such/dir", "/v/x.mp4", { size: 1, mtimeMs: 1 }, "sensevoice")).toBeUndefined();
    const name = transcriptCacheFilename("/v/x.mp4", 1, 1, "sensevoice");
    await writeFile(join(dir, name), "{ not valid json", "utf8");
    expect(await readTranscriptCache(dir, "/v/x.mp4", { size: 1, mtimeMs: 1 }, "sensevoice")).toBeUndefined();
  });
});

describe("pruneCache", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "hotclip-prune-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps only the newest N entries by mtime", async () => {
    // five files with strictly increasing mtimes (1..5 seconds)
    for (let i = 0; i < 5; i++) {
      const p = join(dir, `f${i}.json`);
      await writeFile(p, "{}", "utf8");
      await utimes(p, new Date((i + 1) * 1000), new Date((i + 1) * 1000));
    }
    await pruneCache(dir, 2);
    const left = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort();
    expect(left).toEqual(["f3.json", "f4.json"]); // the two newest survive
  });
});
