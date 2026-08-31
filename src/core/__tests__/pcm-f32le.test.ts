/**
 * ASR 音频输入链(issue #4 重构):ffmpeg 出 raw f32le → Node 读入 Float32Array。
 * 换掉 sherpa readWave(原生层在 Windows 上打不开中文临时路径)后,样本的
 * 字节序/对齐/截断处理全在我们手里——这里用真 ffmpeg 钉死端到端字节正确性。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { resolveFfmpegPath } from "../binaries";
import { extractPcmF32le16k, readF32leSamples } from "../models";

const execFileAsync = promisify(execFile);

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "hotclip-pcm-"));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("readF32leSamples", () => {
  it("按小端 float32 读入,尾部不足 4 字节的残片丢弃", async () => {
    const path = join(base, "samples.f32le");
    const f32 = Float32Array.from([0, 0.5, -0.5, 1]);
    // 结尾多写 3 个字节模拟被截断的写入
    await writeFile(path, Buffer.concat([Buffer.from(f32.buffer), Buffer.from([1, 2, 3])]));

    const samples = await readF32leSamples(path);
    expect(Array.from(samples)).toEqual([0, 0.5, -0.5, 1]);
  });

  it("空文件读出零样本", async () => {
    const path = join(base, "empty.f32le");
    await writeFile(path, Buffer.alloc(0));
    expect((await readF32leSamples(path)).length).toBe(0);
  });
});

describe("extractPcmF32le16k", () => {
  it("真 ffmpeg 端到端:1 秒 440Hz 正弦 → 16000 个样本,幅值区间正确", async () => {
    const ffmpeg = resolveFfmpegPath();
    const src = join(base, "tone.wav");
    await execFileAsync(ffmpeg, [
      "-hide_banner", "-y",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1:sample_rate=44100",
      src,
    ]);

    const out = join(base, "tone.f32le");
    await extractPcmF32le16k(ffmpeg, src, out);
    const samples = await readF32leSamples(out);

    // 重采样边缘允许极小偏差,但必须落在 16k 采样率的 1 秒附近
    expect(Math.abs(samples.length - 16000)).toBeLessThan(64);
    let peak = 0;
    for (const s of samples) peak = Math.max(peak, Math.abs(s));
    // lavfi sine 源固定振幅 1/8≈0.125:峰值应贴近它——过低说明样本错位,过高说明幅值爆了
    expect(peak).toBeGreaterThan(0.1);
    expect(peak).toBeLessThanOrEqual(0.15);
  });

  it("多音轨素材显式读取 HotClip 选择的音轨", async () => {
    const ffmpeg = resolveFfmpegPath();
    const src = join(base, "two-audio.mka");
    await execFileAsync(ffmpeg, [
      "-hide_banner", "-y",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1:sample_rate=16000",
      "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono:d=1",
      "-map", "0:a:0", "-map", "1:a:0", "-c:a", "pcm_s16le", src,
    ]);

    const tonePath = join(base, "tone-track.f32le");
    const silencePath = join(base, "silence-track.f32le");
    await extractPcmF32le16k(ffmpeg, src, tonePath, undefined, 0);
    await extractPcmF32le16k(ffmpeg, src, silencePath, undefined, 1);
    const tone = await readF32leSamples(tonePath);
    const silence = await readF32leSamples(silencePath);
    expect(Math.max(...tone)).toBeGreaterThan(0.1);
    expect(Math.max(...silence.map(Math.abs))).toBe(0);
  });
});
