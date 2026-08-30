import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { isExecutableColorPlan, planColorRender } from "../color";
import { cutClip, cutJumpClip, runFfmpeg } from "../cut";
import { probeMedia } from "../probe";

const HDR_TRANSFERS = [
  {
    name: "PQ colour bars (BT.2020 non-constant, TV range)",
    transfer: "smpte2084",
    detected: "pq",
    pattern: "smptehdbars=size=320x180:rate=24:duration=1",
    space: "bt2020nc",
    range: "tv",
  },
  {
    name: "HLG saturated gradient (BT.2020 non-constant, full range)",
    transfer: "arib-std-b67",
    detected: "hlg",
    pattern: "gradients=size=320x180:rate=24:duration=1:c0=red:c1=blue:x0=0:y0=0:x1=320:y1=180",
    space: "bt2020nc",
    range: "pc",
  },
] as const;

describe("HDR color FFmpeg integration", () => {
  it.each(HDR_TRANSFERS)(
    "tone-maps a tagged synthetic $name 10-bit source to BT.709 SDR",
    async ({ transfer, detected, pattern, space, range }) => {
      const root = await mkdtemp(join(tmpdir(), "hotclip-color-integration-"));
      const source = join(root, `source-${detected}.mkv`);
      const output = join(root, `output-${detected}.mp4`);

      try {
        // FFV1 keeps this fixture lossless and compact while Matroska preserves
        // the stream color tags that drive HotClip's metadata-only HDR detection.
        await runFfmpeg([
          "-hide_banner", "-y",
          "-f", "lavfi", "-i", pattern,
          "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
          "-c:v", "ffv1",
          "-level", "3",
          "-pix_fmt", "yuv420p10le",
          "-color_primaries", "bt2020",
          "-color_trc", transfer,
          "-colorspace", space,
          "-color_range", range,
          "-c:a", "pcm_s16le",
          "-shortest",
          source,
        ]);

        const input = await probeMedia(source);
        expect(input.pixelFormat).toBe("yuv420p10le");
        expect(input.bitDepth).toBe(10);
        expect(input.colorTransfer).toBe(transfer);

        const color = planColorRender(input);
        expect(color.detected).toBe(detected);
        expect(color.action).toBe("tonemap-bt709");

        expect(await cutClip(source, output, 0, 1, { color })).toBe("encode");

        const rendered = await probeMedia(output);
        expect(rendered.hasVideo).toBe(true);
        expect(rendered.hasAudio).toBe(true);
        expect(rendered.pixelFormat).toBe("yuv420p");
        expect(rendered.colorRange).toBe("tv");
        expect(rendered.colorSpace).toBe("bt709");
        expect(rendered.colorTransfer).toBe("bt709");
        expect(rendered.colorPrimaries).toBe("bt709");
        expect(rendered.durationSec).toBeGreaterThan(0.9);
        expect(rendered.durationSec).toBeLessThan(1.1);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    20_000
  );

  it("keeps a transfer-only HDR file exportable instead of guessing missing colour tags", async () => {
    const root = await mkdtemp(join(tmpdir(), "hotclip-color-incomplete-"));
    const source = join(root, "source-transfer-only.mkv");
    const output = join(root, "output-transfer-only.mp4");

    try {
      await runFfmpeg([
        "-hide_banner", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=1",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
        "-c:v", "ffv1",
        "-level", "3",
        "-pix_fmt", "yuv420p10le",
        "-color_primaries", "unknown",
        "-color_trc", "smpte2084",
        "-colorspace", "unknown",
        "-color_range", "unknown",
        "-c:a", "pcm_s16le",
        "-shortest",
        source,
      ]);

      const input = await probeMedia(source);
      expect(input.colorTransfer).toBe("smpte2084");
      const color = planColorRender(input);
      expect(color).toMatchObject({
        detected: "pq",
        action: "passthrough",
        reason: "hdr-pq-unsupported-color-path-passthrough",
      });
      expect(await cutClip(source, output, 0, 1, { color })).toBe("encode");
      const rendered = await probeMedia(output);
      expect(rendered.hasVideo).toBe(true);
      expect(rendered.durationSec).toBeGreaterThan(0.9);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it.each([
    {
      name: "SDR first, PQ default second",
      order: ["sdr", "pq"] as const,
      expected: "pq" as const,
      width: 320,
    },
    {
      name: "PQ first, SDR default second",
      order: ["pq", "sdr"] as const,
      expected: "sdr" as const,
      width: 256,
    },
  ])("keeps probe and render on the same stream for $name", async ({ order, expected, width }) => {
    const root = await mkdtemp(join(tmpdir(), "hotclip-color-multistream-"));
    const source = join(root, "source.mkv");
    const output = join(root, "output.mp4");
    const jumpOutput = join(root, "output-jump.mp4");
    const pattern = (kind: "pq" | "sdr"): string => kind === "pq"
      ? "smptehdbars=size=320x180:rate=24:duration=1"
      : "testsrc2=size=256x144:rate=24:duration=1";

    try {
      const args = [
        "-hide_banner", "-y",
        "-f", "lavfi", "-i", pattern(order[0]),
        "-f", "lavfi", "-i", pattern(order[1]),
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
        "-map", "0:v:0", "-map", "1:v:0", "-map", "2:a:0",
        "-c:v", "ffv1", "-level:v:0", "3", "-level:v:1", "3",
        "-c:a", "pcm_s16le",
      ];
      for (let index = 0; index < order.length; index++) {
        const pq = order[index] === "pq";
        args.push(
          `-pix_fmt:v:${index}`, pq ? "yuv420p10le" : "yuv420p",
          `-color_primaries:v:${index}`, pq ? "bt2020" : "bt709",
          `-color_trc:v:${index}`, pq ? "smpte2084" : "bt709",
          `-colorspace:v:${index}`, pq ? "bt2020nc" : "bt709",
          `-color_range:v:${index}`, "tv",
          `-disposition:v:${index}`, index === 1 ? "default" : "0"
        );
      }
      args.push("-shortest", source);
      await runFfmpeg(args);

      const input = await probeMedia(source);
      expect(input.videoStreamIndex).toBe(1);
      expect(input.audioStreamIndex).toBe(2);
      expect(input.width).toBe(width);
      expect(input.colorTransfer).toBe(expected === "pq" ? "smpte2084" : "bt709");

      const planned = planColorRender(input);
      expect(planned.detected).toBe(expected);
      const renderOptions = {
        videoStreamIndex: input.videoStreamIndex,
        audioStreamIndex: input.audioStreamIndex,
        color: isExecutableColorPlan(planned) ? planned : undefined,
      };
      await cutClip(source, output, 0, 1, renderOptions);
      await cutJumpClip(
        source,
        jumpOutput,
        0,
        [{ startSec: 0, endSec: 0.4 }, { startSec: 0.6, endSec: 1 }],
        renderOptions
      );

      const rendered = await probeMedia(output);
      expect(rendered.width).toBe(width);
      expect(rendered.colorTransfer).toBe("bt709");
      expect(rendered.colorPrimaries).toBe("bt709");
      expect(rendered.colorSpace).toBe("bt709");
      expect(rendered.hasAudio).toBe(true);
      const jumped = await probeMedia(jumpOutput);
      expect(jumped.width).toBe(width);
      expect(jumped.colorTransfer).toBe("bt709");
      expect(jumped.colorPrimaries).toBe("bt709");
      expect(jumped.colorSpace).toBe("bt709");
      expect(jumped.hasAudio).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
