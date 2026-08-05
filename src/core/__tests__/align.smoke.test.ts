/**
 * 精准切点真模型冒烟(env 门控,CI 不跑):
 *   HOTCLIP_ALIGN_SMOKE=1 pnpm vitest run src/core/__tests__/align.smoke.test.ts
 * 流程:macOS say 合成中文语音 → SenseVoice(本机已装)转写拿词表 →
 * 人为整体平移 +0.6s 模拟「反向对齐不准」→ createClipAligner 二遍对齐 →
 * 断言词表被拉回原位附近。首次运行会把 Paraformer 模型(~240MB)下载到
 * 应用模型目录(与桌面端共用,不白下)。
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";

const RUN = process.env.HOTCLIP_ALIGN_SMOKE === "1" && process.platform === "darwin";

describe.runIf(RUN)("align 真模型冒烟", () => {
  it("平移过的词表被 Paraformer 二遍对齐拉回原位", { timeout: 15 * 60_000 }, async () => {
    const { SenseVoiceEngine } = await import("../transcribe/sensevoice");
    const { createClipAligner } = await import("../align");
    const modelsRoot = join(homedir(), "Library/Application Support/hotclip/models");

    // 1) 合成 ~15s 中文语音(带一句停顿制造多段词)
    const wav = join(tmpdir(), "hotclip-align-smoke.wav");
    execFileSync("say", [
      "-v", "Tingting", "-o", wav, "--data-format=LEI16@16000",
      "今天给大家推荐一款产品,原价一百九十九,今天直播间只要九十九。用过的都说好,库存只剩最后两百件,喜欢的抓紧下单。",
    ]);

    // 2) SenseVoice 转写拿词表(本机已装,不触发下载)
    const sv = new SenseVoiceEngine(modelsRoot);
    const transcript = await sv.transcribe(wav);
    const words = transcript.segments.flatMap((s) => s.words);
    expect(words.length).toBeGreaterThan(10);
    const origFirstStart = words[0].startSec;

    // 3) 整体平移 +0.6s 模拟不准的词表
    const shifted = words.map((w) => ({ ...w, startSec: w.startSec + 0.6, endSec: w.endSec + 0.6 }));

    // 4) 二遍对齐(首次会下载 Paraformer ~240MB)
    const align = createClipAligner(modelsRoot);
    const refined = await align(wav, {
      startSec: 0,
      endSec: transcript.durationSec,
      words: shifted,
    });

    expect(refined).not.toBeNull();
    // 对齐后首词回到原位 ±0.3s(Paraformer CIF 时间戳应与 SenseVoice 原始
    // 时间大致一致,而与 +0.6s 的平移版明显不同)
    expect(Math.abs(refined![0].startSec - origFirstStart)).toBeLessThan(0.3);
    expect(Math.abs(refined![0].startSec - shifted[0].startSec)).toBeGreaterThan(0.25);
    // 单调无倒流
    for (let i = 1; i < refined!.length; i++) {
      expect(refined![i].startSec).toBeGreaterThanOrEqual(refined![i - 1].endSec - 1e-3);
    }
    rmSync(wav, { force: true });
  });
});

describe.runIf(!RUN)("align 真模型冒烟(跳过)", () => {
  it("需要 HOTCLIP_ALIGN_SMOKE=1 且 macOS 才运行", () => {
    expect(true).toBe(true);
  });
});
