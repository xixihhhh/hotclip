import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { cameraRect, normalizeCameraRegion } from "../../shared/game-camera";
import { resolveFfmpegPath } from "../binaries";
import { runFfmpeg } from "../cut";
import { exportClips } from "../export";
import { probeMedia } from "../probe";

const region = { x: 0.85, y: 0.18, width: 0.25 };

// A circular yellow face at the top right, two red edge markers in the game.
// The circle's bounding box detects accidental stretching in either pane.
function gameFrame(w: number, h: number, face: boolean): Buffer {
  const data = Buffer.alloc(w * h * 3);
  const rect = cameraRect(region, w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const marker = (x < w * 0.1 || x > w * 0.9) && y > h * 0.46 && y < h * 0.54;
      const inCamera = x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;
      const inFace = face && Math.hypot(x - w * region.x, y - h * region.y) <= rect.height * 0.25;
      const rgb = inFace ? [245, 220, 20] : inCamera ? [28, 58, 150] : marker ? [238, 12, 24] : [45, 96, 56];
      data.set(rgb, (y * w + x) * 3);
    }
  }
  return Buffer.concat([Buffer.from(`P6\n${w} ${h}\n255\n`), data]);
}

it.each([
  ["landscape", 640, 360, true],
  ["portrait", 360, 640, true],
  ["no-face", 640, 360, false],
] as const)("exports the camera and entire game for %s footage", async (name, w, h, face) => {
  const root = await mkdtemp(join(tmpdir(), "hotclip-camera-"));
  try {
    const still = join(root, "game.ppm");
    const source = join(root, "game.mp4");
    await writeFile(still, gameFrame(w, h, face));
    await runFfmpeg(["-y", "-loop", "1", "-framerate", "10", "-i", still, "-f", "lavfi", "-i", "sine=frequency=440", "-t", "2", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", source]);
    const spec = { id: 1, title: "Game", startSec: 0, endSec: 2, words: [{ text: "Camera test", startSec: 0.1, endSec: 1.8 }] };
    const out = join(root, "out");
    const [result] = await exportClips(source, [{
      ...spec, pieces: name === "landscape" ? [{ startSec: 0, endSec: 0.8 }, { startSec: 1.1, endSec: 2 }] : undefined,
    }], out, { vertical: true, gameCamera: region, trimUi: true, faceTrack: true, autoZoom: true, captionStyle: "keyword", qa: false });
    expect(await probeMedia(result.path)).toMatchObject({ width: 1080, height: 1920, hasAudio: true });
    const manifest = JSON.parse(await readFile(join(out, "clips.json"), "utf8"));
    expect(manifest.clips[0].render).toMatchObject({ reframe: "game-camera", captionsBurned: true });
    const rgb = execFileSync(resolveFfmpegPath(), ["-v", "error", "-ss", "0.4", "-i", result.path, "-frames:v", "1", "-vf", "scale=270:480", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]);
    const upper: number[][] = [];
    const lower: number[][] = [];
    const redX: number[] = [];
    let captionPixels = 0;
    for (let y = 0; y < 480; y++) {
      for (let x = 0; x < 270; x++) {
        const i = (y * 270 + x) * 3;
        const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
        if (r > 165 && g > 140 && b < 72) (y < 192 ? upper : lower).push([x, y]);
        if (y > 192 && r > 155 && g < 85 && b < 85) redX.push(x);
        if (y > 220 && r > 190 && g > 190 && b > 190) captionPixels++;
      }
    }
    expect(captionPixels).toBeGreaterThan(10);
    const visibleWidth = Math.min(270, 288 * w / h);
    expect(Math.min(...redX)).toBeLessThan(135 - visibleWidth * 0.43);
    expect(Math.max(...redX)).toBeGreaterThan(135 + visibleWidth * 0.43);
    for (const points of [upper, lower]) {
      if (!face) {
        expect(points).toHaveLength(0);
        continue;
      }
      const xs = points.map(([x]) => x), ys = points.map(([, y]) => y);
      const width = Math.max(...xs) - Math.min(...xs), height = Math.max(...ys) - Math.min(...ys);
      expect(width / height).toBeGreaterThan(0.8);
      expect(width / height).toBeLessThan(1.2);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it("clamps manual regions and rejects invalid values", () => {
  expect(normalizeCameraRegion({ x: -1, y: 2, width: 5 })).toEqual({ x: 0, y: 1, width: 1 });
  expect(normalizeCameraRegion({ x: NaN, y: 0, width: 0.2 })).toBeUndefined();
});
