import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { resolveFfmpegPath } from "../binaries";
import { checkpointDirectory, transcribeWindows } from "../transcribe/windowed";

let dir: string, media: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "hotclip-window-test-")); media = join(dir, "source.wav");
  execFileSync(resolveFfmpegPath(), ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=60", "-ar", "16000", media]);
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe("bounded resumable transcription", () => {
  it("commits each completed decode, resumes only missing windows, and honors explicit restart", async () => {
    const cacheDir = join(dir, "resume");
    const abort = new AbortController();
    const offsets: number[] = [];
    const decode = async (samples: Float32Array, start: number, end: number) => {
      expect(samples.length).toBeLessThanOrEqual(28 * 16000);
      offsets.push(start);
      return { language: "en", words: [{ text: `word${start}`, startSec: start, endSec: Math.min(start + 1, end), timingSource: "native" as const }] };
    };
    await expect(transcribeWindows(media, "test", "model-v1", { cacheDir, signal: abort.signal, onProgress: (p) => { if (p.completedWindows === 2) abort.abort(); } }, decode)).rejects.toThrow();
    expect(offsets).toEqual([0, 28]);
    const resumed: number[] = [];
    const result = await transcribeWindows(media, "test", "model-v1", { cacheDir, onProgress: (p) => { if (p.resumedWindows !== undefined) resumed.push(p.resumedWindows); } }, decode);
    expect(offsets).toEqual([0, 28, 56]);
    expect(resumed.every((n) => n === 2)).toBe(true);
    expect(result.segments.flatMap((s) => s.words).map((w) => w.text)).toEqual(["word0", "word28", "word56"]);
    expect(result.durationSec).toBeCloseTo(60);
    offsets.length = 0;
    await transcribeWindows(media, "test", "model-v1", { cacheDir, restart: true }, decode);
    expect(offsets).toEqual([0, 28, 56]);
  });

  it("a corrupt checkpoint cannot poison the output; model changes miss", async () => {
    const cacheDir = join(dir, "corrupt");
    const decode = async (_: Float32Array, start: number) => ({ words: [{ text: "ok", startSec: start, endSec: start + 0.1 }] });
    await transcribeWindows(media, "test", "v1", { cacheDir }, decode);
    const checkpoint = await checkpointDirectory(cacheDir, media, "v1:auto");
    await writeFile(join(checkpoint, "1.json"), JSON.stringify({ words: [{ text: "bad", startSec: -900, endSec: 10000 }] }));
    const offsets: number[] = [];
    await transcribeWindows(media, "test", "v1", { cacheDir }, async (samples, start) => { offsets.push(start); return decode(samples, start); });
    expect(offsets).toEqual([28, 56]);
    offsets.length = 0;
    await transcribeWindows(media, "test", "v2", { cacheDir }, async (samples, start) => { offsets.push(start); return decode(samples, start); });
    expect(offsets).toEqual([0, 28, 56]);
    expect((await readdir(checkpoint)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("rejects invalid decoder output before caching it", async () => {
    await expect(transcribeWindows(media, "test", "bad", { cacheDir: join(dir, "bad") }, async () => ({ words: [{ text: "bad", startSec: 0, endSec: 100 }] }))).rejects.toThrow("invalid-window-timestamps");
  });
  it("does not send exact digital silence to a speech model", async () => {
    const silent = join(dir, "silence.wav");
    execFileSync(resolveFfmpegPath(), ["-v", "error", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "2", silent]);
    let calls = 0;
    const result = await transcribeWindows(silent, "test", "silence", {}, async () => { calls++; return { words: [] }; });
    expect(calls).toBe(0);
    expect(result.segments).toEqual([]);
    expect(result.durationSec).toBe(2);
  });
});
