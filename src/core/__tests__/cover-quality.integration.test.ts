import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { selectQualityCoverTime } from "../cover-quality";
import { runFfmpeg } from "../cut";

describe("quality cover FFmpeg golden set", () => {
  it("rejects black/white frames and ranks the sharp frame above its blurred twin", async () => {
    const root = await mkdtemp(join(tmpdir(), "hotclip-cover-quality-"));
    const video = join(root, "golden.mkv");
    try {
      await runFfmpeg([
        "-hide_banner", "-y",
        "-f", "lavfi", "-i", "color=c=black:size=320x180:rate=24:duration=1",
        "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=1",
        "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=1",
        "-f", "lavfi", "-i", "color=c=white:size=320x180:rate=24:duration=1",
        "-filter_complex",
        "[0:v]format=yuv420p[v0];[1:v]gblur=sigma=14,format=yuv420p[v1];[2:v]format=yuv420p[v2];[3:v]format=yuv420p[v3];[v0][v1][v2][v3]concat=n=4:v=1:a=0[out]",
        "-map", "[out]", "-c:v", "ffv1", "-level", "3", video,
      ]);

      const selection = await selectQualityCoverTime({
        videoPath: video,
        candidates: [0.5, 1.5, 2.5, 3.5].map((atSec) => ({ atSec, source: "uniform" as const, priority: 0.5 })),
        fallbackSec: 0.5,
      });
      expect(selection.mode).toBe("quality-ranked");
      expect(selection.candidatesEvaluated).toBe(4);
      expect(selection.candidatesRejected).toBeGreaterThanOrEqual(2);
      expect(selection.selectedSec).toBe(2.5);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
