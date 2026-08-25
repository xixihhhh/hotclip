import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { cutClip, runFfmpeg } from "../cut";
import { probeMedia } from "../probe";
import { canCopyVideoStream, probeVideoKeyframes } from "../smart-render";
import { createRenderCacheKey, fingerprintRenderFile, restoreRenderCache, storeRenderCache } from "../render-cache";

let root = "";

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

describe("smart render FFmpeg integration", () => {
  it("copies aligned H.264 video, encodes filtered AAC, and reuses the cached base", async () => {
    root = await mkdtemp(join(tmpdir(), "hotclip-smart-render-integration-"));
    const source = join(root, "source.mp4");
    const output = join(root, "clip.mp4");
    const restored = join(root, "restored.mp4");
    const cache = join(root, "render-cache");

    await runFfmpeg([
      "-hide_banner", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "3",
      "-c:v", "libx264",
      "-g", "25",
      "-keyint_min", "25",
      "-sc_threshold", "0",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      source,
    ]);

    const media = await probeMedia(source);
    const keyframes = await probeVideoKeyframes(source, 1);
    expect(canCopyVideoStream(media, 1, { normalizeLoudness: true }, keyframes)).toBe(true);
    expect(await cutClip(source, output, 1, 2.5, { videoCopy: true, normalizeLoudness: true })).toBe("copy");

    const rendered = await probeMedia(output);
    expect(rendered.videoCodec).toBe("h264");
    expect(rendered.audioCodec).toBe("aac");
    expect(rendered.durationSec).toBeGreaterThan(1.4);
    expect(rendered.durationSec).toBeLessThan(1.7);

    const key = createRenderCacheKey({ source: await fingerprintRenderFile(source), range: [1, 2.5] });
    await storeRenderCache(cache, key, output);
    expect(await restoreRenderCache(cache, key, restored)).toBe(true);
    expect((await stat(restored)).size).toBe((await stat(output)).size);
  }, 20_000);
});
