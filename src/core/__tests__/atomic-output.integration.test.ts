import { mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import { join, relative } from "path";
import { tmpdir } from "os";
import { afterEach, describe, expect, it } from "vitest";
import { withAtomicOutput } from "../atomic-output";
import { cutClip, cutJumpClip, concatClips, runFfmpeg } from "../cut";
import { probeMedia } from "../probe";
import { runAudiogram, audiogramSpec } from "../audiogram";

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function workspace(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "hotclip-atomic-test-"));
  folders.push(folder);
  return folder;
}

describe("safe media publication", () => {
  it("preserves existing output on a failed, empty, or cancelled producer and removes only its own workspace", async () => {
    const folder = await workspace();
    const output = join(folder, "成片.mp4");
    const existing = Buffer.from("existing completed output");
    await writeFile(output, existing);
    await writeFile(join(folder, "成片.mp4.list.txt"), "user notes");
    await expect(withAtomicOutput(output, async (path) => {
      await writeFile(path, "incomplete");
      throw new Error("encoder failed");
    })).rejects.toThrow("encoder failed");
    await expect(withAtomicOutput(output, (path) => writeFile(path, ""))).rejects.toThrow("empty");
    const controller = new AbortController();
    await expect(withAtomicOutput(output, async (path) => {
      await writeFile(path, "completed but cancelled");
      controller.abort(new Error("cancelled"));
    }, controller.signal)).rejects.toThrow("cancelled");
    expect(await readFile(output)).toEqual(existing);
    expect((await readdir(folder)).sort()).toEqual(["成片.mp4", "成片.mp4.list.txt"]);
  });

  it("waits for a real FFmpeg cancellation before removing its output, preserving the old file", async () => {
    const folder = await workspace();
    const output = join(folder, "existing.mp4");
    await writeFile(output, "previous output");
    const controller = new AbortController();
    let sawProgress = false;
    await expect(withAtomicOutput(output, (path) => runFfmpeg([
      "-hide_banner", "-y", "-re", "-f", "lavfi", "-i", "color=size=96x64:rate=10",
      "-t", "20", "-c:v", "libx264", "-pix_fmt", "yuv420p", path,
    ], { signal: controller.signal, onTimeSec: () => { sawProgress = true; controller.abort(new Error("cancelled")); } }), controller.signal)).rejects.toThrow("cancelled");
    expect(sawProgress).toBe(true);
    expect(await readFile(output, "utf8")).toBe("previous output");
    expect(await readdir(folder)).toEqual(["existing.mp4"]);
  }, 10_000);

  it("publishes playable cut, jump-cut, concat and audiogram outputs without clobbering concat notes", async () => {
    const folder = await workspace();
    const source = join(folder, "source.mp4");
    await runFfmpeg(["-hide_banner", "-y", "-f", "lavfi", "-i", "color=size=96x64:rate=10", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", source]);
    const cut = join(folder, "cut.mp4"), jump = join(folder, "jump.mp4"), concat = join(folder, "concat.mp4"), audio = join(folder, "audio.mp4");
    await cutClip(source, cut, 0, 1);
    await cutJumpClip(source, jump, 0, [{ startSec: 0, endSec: 0.4 }, { startSec: 1, endSec: 1.5 }]);
    await writeFile(`${concat}.list.txt`, "keep these user notes");
    await concatClips([relative(process.cwd(), cut), cut], concat);
    await runAudiogram(source, audio, [{ startSec: 0, endSec: 0.2 }], { spec: { ...audiogramSpec(false), width: 160, height: 96, waveHeight: 32 } });
    for (const path of [cut, jump, concat, audio]) {
      const info = await probeMedia(path);
      expect(info.hasVideo).toBe(true);
      expect(info.durationSec).toBeGreaterThan(0.1);
    }
    expect(await readFile(`${concat}.list.txt`, "utf8")).toBe("keep these user notes");
    expect((await readdir(folder)).some((name) => name.startsWith(".hotclip-write-"))).toBe(false);
  }, 20_000);
});
