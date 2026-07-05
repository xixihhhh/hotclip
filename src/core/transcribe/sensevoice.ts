/**
 * Local ASR, speed tier: SenseVoice-Small via sherpa-onnx (Apache-2.0).
 * zh/yue/en/ja/ko in one ~170MB model, per-token timestamps, ~15x realtime
 * on CPU — the zero-config offline default. Emits its own punctuation (ITN).
 */
import { join } from "path";
import { SENSEVOICE_MODEL } from "../models";
import { SherpaOfflineEngine } from "./sherpa-offline";

// Re-exported for tests and legacy imports; implementation moved to sherpa-offline.
export { tokensToWords } from "./sherpa-offline";

export class SenseVoiceEngine extends SherpaOfflineEngine {
  constructor(modelsRoot: string) {
    super(
      {
        id: "sensevoice-local",
        label: "SenseVoice (本地免费 · zh/en/ja/ko/yue)",
        asset: SENSEVOICE_MODEL,
        buildModelConfig: (dir) => ({
          senseVoice: {
            model: join(dir, "model.int8.onnx"),
            useInverseTextNormalization: 1,
          },
        }),
        language: (result) => result.lang?.replace(/[<|>]/g, ""),
      },
      modelsRoot
    );
  }
}
