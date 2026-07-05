/**
 * Local ASR engine, accuracy tier: Paraformer-large zh/en via sherpa-onnx
 * (Apache-2.0). Lower zh CER than SenseVoice-Small at ~2x the model size;
 * per-token timestamps. Same windowed decode strategy as SenseVoice.
 */
import { join } from "path";
import { rm } from "fs/promises";
import { tmpdir } from "os";
import { resolveFfmpegPath } from "../binaries";
import { ensureModel, extractWav16k, isModelInstalled, modelDir, PARAFORMER_MODEL, PUNCT_MODEL } from "../models";
import { segmentWords, joinWords } from "./segment";
import { applyPunctuation } from "./punctuate";
import { tokensToWords } from "./sensevoice";
import type { Transcript, TranscribeEngine, TranscribeOptions, TranscriptWord } from "./types";

const WINDOW_SEC = 28;

/* eslint-disable @typescript-eslint/no-explicit-any */
let sherpa: any = null;
function loadSherpa(): any {
  if (!sherpa) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sherpa = require("sherpa-onnx-node");
  }
  return sherpa;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export class ParaformerEngine implements TranscribeEngine {
  id = "paraformer-local";
  label = "Paraformer (本地 · 中文更准 · zh/en)";

  constructor(private modelsRoot: string) {}

  async isReady(): Promise<boolean> {
    return isModelInstalled(this.modelsRoot, PARAFORMER_MODEL);
  }

  async transcribe(filePath: string, options: TranscribeOptions = {}): Promise<Transcript> {
    const { onProgress, signal } = options;

    onProgress?.({ fraction: 0, stage: "downloading-model" });
    await ensureModel(
      this.modelsRoot,
      PARAFORMER_MODEL,
      (p) => onProgress?.({ fraction: 0, stage: "downloading-model", ...p }),
      signal
    );
    // Paraformer emits no punctuation — a small CT-Transformer restores it
    await ensureModel(
      this.modelsRoot,
      PUNCT_MODEL,
      (p) => onProgress?.({ fraction: 0, stage: "downloading-model", ...p }),
      signal
    );

    onProgress?.({ fraction: 0, stage: "decoding" });
    const wavPath = join(tmpdir(), `hotclip-${Date.now()}-16k.wav`);
    try {
      await extractWav16k(resolveFfmpegPath(), filePath, wavPath);

      const sh = loadSherpa();
      const dir = modelDir(this.modelsRoot, PARAFORMER_MODEL);
      const recognizer = new sh.OfflineRecognizer({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          paraformer: { model: join(dir, "model.int8.onnx") },
          tokens: join(dir, "tokens.txt"),
          numThreads: 2,
          provider: "cpu",
          debug: 0,
        },
      });

      const punctDir = modelDir(this.modelsRoot, PUNCT_MODEL);
      const punct = new sh.OfflinePunctuation({
        model: {
          ctTransformer: join(punctDir, "model.int8.onnx"),
          numThreads: 1,
          provider: "cpu",
          debug: 0,
        },
      });

      const wave = sh.readWave(wavPath) as { samples: Float32Array; sampleRate: number };
      const sampleRate: number = wave.sampleRate;
      const durationSec = wave.samples.length / sampleRate;
      const windowSamples = WINDOW_SEC * sampleRate;

      const allWords: TranscriptWord[] = [];
      for (let start = 0; start < wave.samples.length; start += windowSamples) {
        if (signal?.aborted) throw new Error("transcription cancelled");
        const chunk = wave.samples.subarray(start, Math.min(start + windowSamples, wave.samples.length));
        const offsetSec = start / sampleRate;
        const stream = recognizer.createStream();
        stream.acceptWaveform({ sampleRate, samples: chunk });
        recognizer.decode(stream);
        const result = recognizer.getResult(stream) as {
          text: string;
          tokens?: string[];
          timestamps?: number[];
        };
        let words = tokensToWords(result, offsetSec, offsetSec + chunk.length / sampleRate);
        if (words.length > 0) {
          // per-window punctuation: ~28s of speech is ample sentence context
          words = applyPunctuation(words, punct.addPunct(joinWords(words)) as string);
        }
        allWords.push(...words);
        onProgress?.({
          fraction: Math.min(1, (start + chunk.length) / wave.samples.length),
          stage: "transcribing",
        });
      }

      onProgress?.({ fraction: 1, stage: "finalizing" });
      return {
        // Paraformer-large is a zh-dominant bilingual model — no language token output.
        language: "zh",
        segments: segmentWords(allWords),
        engine: this.id,
        durationSec,
      };
    } finally {
      await rm(wavPath, { force: true });
    }
  }
}
