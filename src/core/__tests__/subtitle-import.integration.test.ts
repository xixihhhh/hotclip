import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../transcribe/sensevoice", () => ({
  SenseVoiceEngine: vi.fn(function () { throw new Error("ASR must not run for subtitle import"); }),
}));

import { runFfmpeg } from "../cut";
import { exportClips } from "../export";
import { probeMedia } from "../probe";
import { importSubtitleFile } from "../subtitle-import";
import { transcribeCached } from "../pipeline";
import { readTranscriptCache, writeTranscriptCache } from "../transcribe/cache";
import { SenseVoiceEngine } from "../transcribe/sensevoice";
import { selectionToPieces } from "../../shared/pick";
import { parseSubtitleTranscript } from "../../shared/subtitle-import";
import { saveSessionCheckpoint, readSessionCheckpoint } from "../session-checkpoint";

const TEXT = "1\n00:00:01,000 --> 00:00:03,000\nKeep this opening.\n\n2\n00:00:03,000 --> 00:00:05,000\nRemove this sentence.\n\n3\n00:00:05,000 --> 00:00:07,000\nKeep this ending.\n";
let root: string;
let source: string;
let subtitle: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "hotclip-subtitle-import-"));
  source = join(root, "source.mp4");
  subtitle = join(root, "original.SRT");
  await writeFile(subtitle, TEXT);
  await runFfmpeg([
    "-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=8",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=8",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source,
  ]);
}, 30_000);
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("subtitle import to media export", () => {
  it("CLI imports without model setup and emits machine-readable timing provenance", async () => {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [
      "--import", "tsx", "src/cli/index.ts", "transcribe", source, "--subtitles", subtitle, "--json",
    ], { timeout: 10_000 });
    const transcript = JSON.parse(stdout);
    expect(transcript.engine).toBe("subtitle-srt");
    expect(transcript.segments[0].words[0].timingSource).toBe("estimated");
    expect(stderr).toContain("已导入字幕");
  }, 15_000);

  it("MCP stdio forwards the subtitle path to the same import pipeline", async () => {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(process.execPath, ["--import", "tsx", "src/mcp/server.ts"], { timeout: 10_000 }, (error, stdout) => {
        if (error) reject(error); else resolve(stdout);
      });
      child.stdin!.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
        name: "transcribe_video", arguments: { videoPath: source, subtitlePath: subtitle },
      } }) + "\n");
    });
    const response = JSON.parse(stdout.trim());
    expect(response.result.isError).not.toBe(true);
    expect(response.result.content[0].text).toContain("subtitle-srt");
    expect(response.result.content[0].text).toContain("Keep this opening.");
  }, 15_000);

  it("recovers imported text and estimated timing even after the sidecar is removed", async () => {
    const temporarySidecar = join(root, "discard.srt");
    await writeFile(temporarySidecar, TEXT);
    const transcript = await importSubtitleFile(source, temporarySidecar);
    const sessionDir = join(root, "session");
    expect(await saveSessionCheckpoint(sessionDir, {
      file: { ...await probeMedia(source), path: source }, transcript,
      candidates: null, selected: [], focusedId: null,
      stats: { funnel: null, vision: null, emotion: null, danmaku: null, voice: null, reference: null, referenceError: null },
      diarize: false, referencePath: null, paramsDirty: false, savedAt: new Date().toISOString(),
    })).toBe(true);
    await rm(temporarySidecar);
    expect((await readSessionCheckpoint(sessionDir))?.transcript).toEqual(transcript);
  });

  it("imports without ASR, preserves reviewed text and leaves the ASR cache unchanged", async () => {
    const cache = join(root, "cache");
    const fileStat = await stat(source);
    const original = parseSubtitleTranscript(TEXT.replace("opening", "cached"), "srt", 8);
    await writeTranscriptCache(cache, source, fileStat, "sensevoice", original);
    const before = await readdir(cache);
    const t = await transcribeCached(source, join(root, "no-models"), cache, [{ wrong: "opening", right: "wrong" }], undefined, subtitle);
    expect(t.segments[0].text).toBe("Keep this opening.");
    expect(t.durationSec).toBeCloseTo(8, 1);
    expect(SenseVoiceEngine).not.toHaveBeenCalled();
    expect(await readdir(cache)).toEqual(before);
    expect(await readTranscriptCache(cache, source, fileStat, "sensevoice")).toEqual(original);
  });

  it("reads edited sidecars afresh and fails explicitly without falling back to ASR", async () => {
    const edited = join(root, "edited.srt");
    await writeFile(edited, TEXT.replace("opening", "updated"));
    expect((await importSubtitleFile(source, edited)).segments[0].text).toContain("updated");
    await writeFile(edited, "bad subtitle");
    await expect(transcribeCached(source, "unused", "unused", undefined, undefined, edited)).rejects.toThrow("subtitle-import:cue");
    expect(SenseVoiceEngine).not.toHaveBeenCalled();
  });

  it("rejects unreadable source, invalid UTF-8, wrong extensions and cancelled requests", async () => {
    await expect(importSubtitleFile(join(root, "missing.mp4"), subtitle)).rejects.toThrow();
    const invalid = join(root, "invalid.srt");
    await writeFile(invalid, Buffer.from([0xff, 0xfe, 0x31, 0]));
    await expect(importSubtitleFile(source, invalid)).rejects.toThrow("encoding");
    await expect(importSubtitleFile(source, join(root, "other.txt"))).rejects.toThrow("format");
    const abort = new AbortController();
    abort.abort();
    await expect(importSubtitleFile(source, subtitle, abort.signal)).rejects.toThrow();
  });

  it("exports selected nonadjacent cues with correct output timing and uncertainty receipts", async () => {
    const transcript = await importSubtitleFile(source, subtitle);
    const pieces = selectionToPieces(transcript.segments, new Set([1, 3]));
    const words = transcript.segments.filter((segment) => segment.id !== 2).flatMap((segment) => segment.words);
    const outDir = join(root, "export");
    const [result] = await exportClips(source, [{
      id: 1, title: "Imported captions", startSec: 1, endSec: 7, manualBounds: true, pieces, words,
    }], outDir, { vertical: false, captionStyle: "minimal", subtitleFile: true, timeline: true, qa: false });
    const media = await probeMedia(result.path);
    expect(media.durationSec).toBeCloseTo(4, 1);
    const srt = await readFile(result.path.replace(/\.mp4$/, ".srt"), "utf8");
    expect(srt).toContain("Keep this opening.");
    expect(srt).toContain("Keep this ending.");
    expect(srt).not.toContain("Remove");
    expect(srt).toContain("00:00:00,000");
    expect(srt).toContain("00:00:04,000");
    const metadata = JSON.parse(await readFile(join(outDir, "clips.json"), "utf8"));
    expect(metadata.clips[0].render).toMatchObject({
      stitchedPieces: 2,
      captionsBurned: true,
      subtitleQuality: { status: "warn", uncertainWords: words.length },
    });
    expect(await readFile(join(outDir, "timeline.edl"), "utf8")).toContain("Imported captions");
  }, 30_000);
});
