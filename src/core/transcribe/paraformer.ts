/**
 * Local ASR, balanced tier: Paraformer-large zh/en via sherpa-onnx
 * (Apache-2.0). Lower zh CER than SenseVoice-Small at ~230MB; per-token
 * timestamps; punctuation restored via CT-Transformer (model emits none).
 */
import { join } from "path";
import { PARAFORMER_MODEL } from "../models";
import { SherpaOfflineEngine } from "./sherpa-offline";

export class ParaformerEngine extends SherpaOfflineEngine {
  constructor(modelsRoot: string) {
    super(
      {
        id: "paraformer-local",
        label: "Paraformer (本地 · 中文更准 · zh/en)",
        asset: PARAFORMER_MODEL,
        buildModelConfig: (dir) => ({
          paraformer: { model: join(dir, "model.int8.onnx") },
        }),
        // zh-dominant bilingual model — no language token output
        language: "zh",
        punctuate: true,
      },
      modelsRoot
    );
  }
}
