/**
 * Local ASR, accuracy tier: FireRedASR2-CTC via sherpa-onnx (Apache-2.0,
 * XiaoHongShu FireRedTeam 2026-02). Roughly half the relative error rate of
 * SenseVoice-Small on Mandarin, strongest on dialects/accents and zh-en
 * code-switching; per-token timestamps; punctuation via CT-Transformer.
 * 520MB download, ~1.5-2GB peak RAM — still fine on 8GB machines.
 */
import { join } from "path";
import { cpus } from "os";
import { FIRERED_MODEL } from "../models";
import { SherpaOfflineEngine } from "./sherpa-offline";

export class FireRedEngine extends SherpaOfflineEngine {
  constructor(modelsRoot: string) {
    super(
      {
        id: "fireredasr-local",
        label: "FireRedASR2 (本地 · 最准 · zh/方言/en)",
        asset: FIRERED_MODEL,
        buildModelConfig: (dir) => ({
          fireRedAsrCtc: { model: join(dir, "model.int8.onnx") },
        }),
        language: "zh",
        punctuate: true,
        // bigger encoder wants more threads; leave headroom for the UI process
        numThreads: Math.min(6, Math.max(2, cpus().length - 2)),
      },
      modelsRoot
    );
  }
}
