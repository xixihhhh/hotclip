import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("../probe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../probe")>();
  return { ...actual, probeMedia: vi.fn(actual.probeMedia) };
});

vi.mock("../media-evidence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../media-evidence")>();
  return { ...actual, collectSignalsEvidence: vi.fn(actual.collectSignalsEvidence) };
});

import { runFfmpeg } from "../cut";
import { exportClips } from "../export";
import { collectSignalsEvidence } from "../media-evidence";
import { probeMedia } from "../probe";

interface ReceiptClip {
  title: string;
  colorConverted: boolean;
  colorConversionSkipped: boolean;
  colorInspectionFailed: boolean;
  render: {
    visualEnhance: unknown;
    color: { detected: string; action: string } | null;
  } | null;
}

async function makeSource(path: string, color: "transfer-only-hdr" | "sdr"): Promise<void> {
  await runFfmpeg([
    "-hide_banner", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
    "-c:v", "ffv1",
    "-level", "3",
    "-pix_fmt", "yuv420p10le",
    "-color_primaries", color === "transfer-only-hdr" ? "unknown" : "bt709",
    "-color_trc", color === "transfer-only-hdr" ? "smpte2084" : "bt709",
    "-colorspace", color === "transfer-only-hdr" ? "unknown" : "bt709",
    "-color_range", color === "transfer-only-hdr" ? "unknown" : "tv",
    "-c:a", "pcm_s16le",
    "-shortest",
    path,
  ]);
}

async function readReceipt(outDir: string): Promise<{ clips: ReceiptClip[] }> {
  return JSON.parse(await readFile(join(outDir, "clips.json"), "utf8")) as { clips: ReceiptClip[] };
}

describe("exportClips HDR colour receipts", () => {
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("../probe")>("../probe");
    vi.mocked(probeMedia).mockReset().mockImplementation(actual.probeMedia);
    vi.mocked(collectSignalsEvidence).mockClear();
  });

  it("marks transfer-only HDR clips and their compilation as skipped without SDR auto-enhance", async () => {
    const root = await mkdtemp(join(tmpdir(), "hotclip-export-color-"));
    const source = join(root, "transfer-only.mkv");
    const outDir = join(root, "out");

    try {
      await makeSource(source, "transfer-only-hdr");
      const results = await exportClips(
        source,
        [
          { id: 1, title: "first", startSec: 0, endSec: 0.8 },
          { id: 2, title: "second", startSec: 1, endSec: 1.8 },
        ],
        outDir,
        { vertical: false, autoEnhance: true, compilation: true, qa: false }
      );

      expect(results).toHaveLength(3);
      for (const result of results) {
        expect(result).toMatchObject({
          colorConverted: false,
          colorConversionSkipped: true,
          colorInspectionFailed: false,
        });
      }
      expect(results.find((result) => result.id === 0)?.title).toBe("精华合集");
      expect(collectSignalsEvidence).not.toHaveBeenCalled();

      const receipt = await readReceipt(outDir);
      const originals = receipt.clips.filter((clip) => clip.render !== null);
      expect(originals).toHaveLength(2);
      for (const clip of originals) {
        expect(clip.colorConversionSkipped).toBe(true);
        expect(clip.render?.visualEnhance).toBeNull();
        expect(clip.render?.color).toMatchObject({ detected: "pq", action: "passthrough" });
      }
      expect(receipt.clips.find((clip) => clip.title === "精华合集")).toMatchObject({
        colorConverted: false,
        colorConversionSkipped: true,
        colorInspectionFailed: false,
        render: null,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("surfaces colour inspection failure and suppresses SDR auto-enhance sampling", async () => {
    const root = await mkdtemp(join(tmpdir(), "hotclip-export-color-probe-"));
    const source = join(root, "source.mkv");
    const outDir = join(root, "out");

    try {
      await makeSource(source, "sdr");
      vi.mocked(probeMedia).mockRejectedValueOnce(new Error("synthetic probe failure"));

      const [result] = await exportClips(
        source,
        [{ id: 1, title: "probe failure", startSec: 0, endSec: 0.8 }],
        outDir,
        { vertical: false, autoEnhance: true, qa: false }
      );

      expect(result).toMatchObject({
        colorConverted: false,
        colorConversionSkipped: false,
        colorInspectionFailed: true,
      });
      expect(collectSignalsEvidence).not.toHaveBeenCalled();

      const receipt = await readReceipt(outDir);
      expect(receipt.clips[0]).toMatchObject({
        colorConverted: false,
        colorConversionSkipped: false,
        colorInspectionFailed: true,
        render: { visualEnhance: null, color: null },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
