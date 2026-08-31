import { describe, expect, it } from "vitest";
import {
  buildBasicDenoisePostpassArgs,
  buildEnhancedAudioReplaceArgs,
  buildPcmExtractArgs,
  deinterleaveChannel,
  enhancePcmChannel,
  interleaveChannel,
  normalizeEnhancementChannels,
} from "../speech-enhancement";
import { DENOISE_FILTER, LOUDNORM_FILTER } from "../cut";

describe("speech enhancement PCM helpers", () => {
  it("preserves mono and bounds wider layouts to stereo", () => {
    expect(normalizeEnhancementChannels(1)).toBe(1);
    expect(normalizeEnhancementChannels("2")).toBe(2);
    expect(normalizeEnhancementChannels(6)).toBe(2);
    expect(normalizeEnhancementChannels(undefined)).toBe(2);
  });

  it("deinterleaves and re-interleaves stereo samples exactly", () => {
    const source = new Float32Array([1, 10, 2, 20, 3, 30]);
    const left = deinterleaveChannel(source, 2, 0);
    const right = deinterleaveChannel(source, 2, 1);
    expect([...left]).toEqual([1, 2, 3]);
    expect([...right]).toEqual([10, 20, 30]);
    const destination = new Float32Array(source.length);
    interleaveChannel(destination, left, 2, 0);
    interleaveChannel(destination, right, 2, 1);
    expect([...destination]).toEqual([...source]);
  });

  it("keeps exact length while retaining only each contextual chunk core", () => {
    const samples = new Float32Array(31 * 48_000);
    samples.fill(0.25);
    let calls = 0;
    const output = enhancePcmChannel(samples, {
      sampleRate: 48_000,
      run: ({ samples: chunk, sampleRate }) => {
        calls += 1;
        return { samples: new Float32Array(chunk.length).fill(calls), sampleRate };
      },
    });
    expect(calls).toBe(2);
    expect(output).toHaveLength(samples.length);
    expect(output[0]).toBe(1);
    expect(output[30 * 48_000 - 1]).toBe(1);
    expect(output[30 * 48_000]).toBe(2);
    expect(output[output.length - 1]).toBe(2);
  });

  it("rejects a model that silently shortens publish audio", () => {
    expect(() => enhancePcmChannel(new Float32Array(1000), {
      sampleRate: 48_000,
      run: () => ({ samples: new Float32Array(400), sampleRate: 48_000 }),
    })).toThrow(/shortened/);
  });

  it("fills only a sub-frame model tail from the original to preserve sync", () => {
    const source = new Float32Array(1000).fill(0.5);
    const output = enhancePcmChannel(source, {
      sampleRate: 48_000,
      run: () => ({ samples: new Float32Array(968).fill(0.25), sampleRate: 48_000 }),
    });
    expect(output).toHaveLength(1000);
    expect(output[967]).toBe(0.25);
    expect(output[968]).toBe(0.5);
    expect(output[999]).toBe(0.5);
  });
});

describe("speech enhancement FFmpeg contracts", () => {
  it("extracts selected clip audio as bounded 48 kHz float PCM", () => {
    expect(buildPcmExtractArgs("/v/in.mp4", "/tmp/in.f32le", 2)).toEqual(expect.arrayContaining([
      "-map", "0:a:0", "-ac", "2", "-ar", "48000", "-c:a", "pcm_f32le",
    ]));
  });

  it("replaces only audio, copies video, and normalizes after learned inference", () => {
    const args = buildEnhancedAudioReplaceArgs("/v/in.mp4", "/tmp/out.f32le", "/v/out.mp4", 2, true);
    expect(args).toEqual(expect.arrayContaining(["-map", "0:v:0?", "-map", "1:a:0", "-c:v", "copy", "-af", LOUDNORM_FILTER]));
    expect(args.indexOf("-af")).toBeGreaterThan(args.indexOf("-i"));
  });

  it("uses the exact historical basic chain before loudness in fallback", () => {
    const args = buildBasicDenoisePostpassArgs("/v/in.mp4", "/v/out.mp4", true);
    expect(args[args.indexOf("-af") + 1]).toBe(`${DENOISE_FILTER},${LOUDNORM_FILTER}`);
    expect(args).toEqual(expect.arrayContaining(["-c:v", "copy"]));
  });
});
