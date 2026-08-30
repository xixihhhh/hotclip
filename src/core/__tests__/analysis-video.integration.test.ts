import { execFile } from "child_process";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { describe, expect, it } from "vitest";
import { resolveFfmpegPath } from "../binaries";
import { planColorRender } from "../color";
import { composeContactSheetJpeg } from "../contact-sheet";
import { runFfmpeg } from "../cut";
import { probeMedia } from "../probe";

const execFileAsync = promisify(execFile);

async function centerRgb(jpegPath: string): Promise<[number, number, number]> {
  const { stdout } = await execFileAsync(
    resolveFfmpegPath(),
    [
      "-hide_banner", "-v", "error", "-i", jpegPath,
      "-vf", "scale=1:1", "-frames:v", "1",
      "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ],
    { encoding: "buffer", maxBuffer: 1024 }
  );
  return [stdout[0] ?? 0, stdout[1] ?? 0, stdout[2] ?? 0];
}

describe("analysis picture FFmpeg integration", () => {
  it("uses the selected HDR video stream and emits a viewable SDR contact sheet", async () => {
    const root = await mkdtemp(join(tmpdir(), "hotclip-analysis-video-"));
    const source = join(root, "dual-video.mkv");
    const selectedJpeg = join(root, "selected.jpg");
    const otherJpeg = join(root, "other.jpg");

    try {
      await runFfmpeg([
        "-hide_banner", "-y",
        "-f", "lavfi", "-i", "color=c=red:size=160x90:rate=24:duration=1",
        "-f", "lavfi", "-i", "color=c=blue:size=320x180:rate=24:duration=1",
        "-map", "0:v:0", "-map", "1:v:0",
        "-c:v", "ffv1", "-level:v:0", "3", "-level:v:1", "3",
        "-pix_fmt:v:0", "yuv420p",
        "-color_primaries:v:0", "bt709", "-color_trc:v:0", "bt709",
        "-colorspace:v:0", "bt709", "-color_range:v:0", "tv",
        "-pix_fmt:v:1", "yuv420p10le",
        "-color_primaries:v:1", "bt2020", "-color_trc:v:1", "smpte2084",
        "-colorspace:v:1", "bt2020nc", "-color_range:v:1", "tv",
        "-disposition:v:0", "0", "-disposition:v:1", "default",
        "-shortest", source,
      ]);

      const media = await probeMedia(source);
      expect(media.videoStreamIndex).toBe(1);
      const color = planColorRender(media);
      expect(color.action).toBe("tonemap-bt709");

      const selected = await composeContactSheetJpeg(source, [0.5], {
        videoStreamIndex: media.videoStreamIndex,
        color,
      });
      const other = await composeContactSheetJpeg(source, [0.5], { videoStreamIndex: 0 });
      expect(selected).not.toBeNull();
      expect(other).not.toBeNull();
      await writeFile(selectedJpeg, Buffer.from(selected!, "base64"));
      await writeFile(otherJpeg, Buffer.from(other!, "base64"));

      const [selectedRed, , selectedBlue] = await centerRgb(selectedJpeg);
      const [otherRed, , otherBlue] = await centerRgb(otherJpeg);
      // Pure synthetic PQ primaries can clip differently across FFmpeg builds,
      // but the selected blue track must still retain substantially more blue
      // than the unselected red SDR track after the SDR preview conversion.
      expect(selectedBlue).toBeGreaterThan(otherBlue + 40);
      expect(Math.max(selectedRed, selectedBlue)).toBeGreaterThan(40);
      expect(otherRed).toBeGreaterThan(otherBlue);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
