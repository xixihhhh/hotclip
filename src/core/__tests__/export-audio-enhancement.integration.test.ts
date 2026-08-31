import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../cut", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cut")>();
  return { ...actual, cutClip: vi.fn(actual.cutClip) };
});

vi.mock("../speech-enhancement", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../speech-enhancement")>();
  return {
    ...actual,
    applySmartDenoiseWithFallback: vi.fn(async () => ({
      requested: "smart" as const,
      applied: "learned" as const,
      modelId: "dpdfnet2-48khz-hr",
      sampleRate: 48_000,
      channels: 1,
    })),
  };
});

import { cutClip, runFfmpeg } from "../cut";
import { exportClips } from "../export";
import { applySmartDenoiseWithFallback } from "../speech-enhancement";

const dirs: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeSource(path: string): Promise<void> {
  await runFfmpeg([
    "-hide_banner", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=1.4",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1.4",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path,
  ]);
}

describe("export smart dialogue enhancement", () => {
  it("defers denoise and loudness to the final smart pass and records the effective tier", async () => {
    const root = await mkdtemp(join(tmpdir(), "hotclip-export-speech-"));
    dirs.push(root);
    const source = join(root, "source.mp4");
    const outDir = join(root, "out");
    await makeSource(source);

    const [result] = await exportClips(
      source,
      [{ id: 1, title: "speech", startSec: 0, endSec: 1.2 }],
      outDir,
      {
        vertical: false,
        denoise: true,
        denoiseMode: "smart",
        normalizeLoudness: true,
        modelsRoot: join(root, "models"),
        qa: false,
      }
    );

    const options = vi.mocked(cutClip).mock.calls[0]?.[4];
    expect(options).toMatchObject({ denoise: false, normalizeLoudness: false });
    expect(applySmartDenoiseWithFallback).toHaveBeenCalledOnce();
    expect(applySmartDenoiseWithFallback).toHaveBeenCalledWith(
      result.path,
      join(root, "models"),
      true,
      undefined
    );
    expect(result.audioEnhancement).toBe("learned");

    const metadata = JSON.parse(await readFile(join(outDir, "clips.json"), "utf8")) as {
      options: { denoiseMode: string };
      clips: Array<{ render: { loudnessNormalized: boolean; audioEnhancement: { applied: string } } }>;
    };
    expect(metadata.options.denoiseMode).toBe("smart");
    expect(metadata.clips[0].render).toMatchObject({
      loudnessNormalized: true,
      audioEnhancement: { applied: "learned", modelId: "dpdfnet2-48khz-hr" },
    });
  }, 30_000);

  it("keeps the legacy basic filter inside the base cut", async () => {
    const root = await mkdtemp(join(tmpdir(), "hotclip-export-basic-"));
    dirs.push(root);
    const source = join(root, "source.mp4");
    const outDir = join(root, "out");
    await makeSource(source);

    const [result] = await exportClips(
      source,
      [{ id: 1, title: "basic", startSec: 0, endSec: 1.2 }],
      outDir,
      { vertical: false, denoise: true, denoiseMode: "basic", normalizeLoudness: true, qa: false }
    );

    const options = vi.mocked(cutClip).mock.calls[0]?.[4];
    expect(options).toMatchObject({ denoise: true, normalizeLoudness: true });
    expect(applySmartDenoiseWithFallback).not.toHaveBeenCalled();
    expect(result.audioEnhancement).toBe("basic");
  }, 30_000);
});
