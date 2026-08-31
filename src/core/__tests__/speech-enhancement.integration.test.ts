import { execFile } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { afterEach, describe, expect, it } from "vitest";
import { resolveFfprobePath } from "../binaries";
import { runFfmpeg } from "../cut";
import { probeMedia } from "../probe";
import { applyLearnedSpeechEnhancement, applySmartDenoiseWithFallback } from "../speech-enhancement";

const execFileAsync = promisify(execFile);
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("learned speech enhancement media integration", () => {
  it("replaces stereo audio at 48 kHz while stream-copying the finished video", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hotclip-speech-integration-"));
    dirs.push(dir);
    const clipPath = join(dir, "clip.mp4");
    await runFfmpeg([
      "-hide_banner", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=1.2",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1.2",
      "-filter_complex", "[1:a]aformat=channel_layouts=stereo[a]",
      "-map", "0:v:0", "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", clipPath,
    ]);
    const before = await probeMedia(clipPath);
    const receipt = await applyLearnedSpeechEnhancement(
      clipPath,
      join(dir, "models"),
      false,
      undefined,
      {
        ensure: async (root) => root,
        probeChannels: async () => 2,
        factory: () => ({
          sampleRate: 48_000,
          run: ({ samples, sampleRate }) => ({ samples: Float32Array.from(samples, (value) => value * 0.8), sampleRate }),
        }),
      }
    );
    const after = await probeMedia(clipPath);
    const { stdout } = await execFileAsync(
      resolveFfprobePath(),
      ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate,channels", "-of", "json", clipPath]
    );
    const audio = JSON.parse(stdout) as { streams: Array<{ sample_rate: string; channels: number }> };
    expect(receipt).toMatchObject({ requested: "smart", applied: "learned", sampleRate: 48_000, channels: 2 });
    expect(after.videoCodec).toBe(before.videoCodec);
    expect(after.durationSec).toBeGreaterThan(1.15);
    expect(audio.streams[0]).toMatchObject({ sample_rate: "48000", channels: 2 });
  });

  it("keeps exporting through the historical basic filter when the learned model is unavailable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hotclip-speech-fallback-"));
    dirs.push(dir);
    const clipPath = join(dir, "clip.mp4");
    await runFfmpeg([
      "-hide_banner", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=1.2",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1.2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clipPath,
    ]);
    const before = await probeMedia(clipPath);

    const receipt = await applySmartDenoiseWithFallback(
      clipPath,
      join(dir, "models"),
      true,
      undefined,
      { ensure: async () => { throw new Error("offline model unavailable"); } }
    );

    const after = await probeMedia(clipPath);
    expect(receipt).toMatchObject({
      requested: "smart",
      applied: "fallback",
      reason: expect.stringContaining("offline model unavailable"),
    });
    expect(after.videoCodec).toBe(before.videoCodec);
    expect(after.durationSec).toBeGreaterThan(1.15);
  });
});
