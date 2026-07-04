/**
 * Local ASR engine: SenseVoice-Small via sherpa-onnx (Apache-2.0).
 * zh/yue/en/ja/ko in one ~170MB model, per-token timestamps, ~15x realtime
 * on CPU — the free offline default. Long audio is chunked on silence-ish
 * boundaries (fixed windows with overlap-free stitching) to bound memory.
 */
import { join } from "path";
import { rm } from "fs/promises";
import { tmpdir } from "os";
import { resolveFfmpegPath } from "../binaries";
import { ensureModel, extractWav16k, isModelInstalled, modelDir, SENSEVOICE_MODEL } from "../models";
import { segmentWords } from "./segment";
import type { Transcript, TranscribeEngine, TranscribeOptions, TranscriptWord } from "./types";

/** Window length per decode call; SenseVoice handles ≤30s comfortably. */
const WINDOW_SEC = 28;

interface SherpaResult {
  text: string;
  tokens?: string[];
  timestamps?: number[];
  lang?: string;
}

/** sherpa-onnx-node is a native addon — require lazily so importing core stays cheap. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sherpa: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadSherpa(): any {
  if (!sherpa) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sherpa = require("sherpa-onnx-node");
  }
  return sherpa;
}

/**
 * Convert one window's sherpa result into timed words offset to absolute time.
 * SenseVoice emits per-token timestamps (start times); each token's end is the
 * next token's start (last token gets +0.3s tail).
 */
export function tokensToWords(result: SherpaResult, offsetSec: number, windowEndSec: number): TranscriptWord[] {
  const tokens = result.tokens ?? [];
  const stamps = result.timestamps ?? [];
  const words: TranscriptWord[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const text = tokens[i];
    if (!text || !text.trim()) continue;
    const start = offsetSec + (stamps[i] ?? 0);
    const nextStamp = stamps[i + 1];
    const end = nextStamp !== undefined ? offsetSec + nextStamp : Math.min(start + 0.3, windowEndSec);
    words.push({ text: text.trim(), startSec: start, endSec: Math.max(end, start) });
  }
  return words;
}

export class SenseVoiceEngine implements TranscribeEngine {
  id = "sensevoice-local";
  label = "SenseVoice (本地免费 · zh/en/ja/ko/yue)";

  constructor(private modelsRoot: string) {}

  async isReady(): Promise<boolean> {
    return isModelInstalled(this.modelsRoot, SENSEVOICE_MODEL);
  }

  async transcribe(filePath: string, options: TranscribeOptions = {}): Promise<Transcript> {
    const { onProgress, signal } = options;

    onProgress?.({ fraction: 0, stage: "downloading-model" });
    await ensureModel(
      this.modelsRoot,
      SENSEVOICE_MODEL,
      (p) => onProgress?.({ fraction: 0, stage: "downloading-model", ...p }),
      signal
    );

    onProgress?.({ fraction: 0, stage: "decoding" });
    const wavPath = join(tmpdir(), `hotclip-${Date.now()}-16k.wav`);
    try {
      await extractWav16k(resolveFfmpegPath(), filePath, wavPath);

      const sh = loadSherpa();
      const dir = modelDir(this.modelsRoot, SENSEVOICE_MODEL);
      const recognizer = new sh.OfflineRecognizer({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          senseVoice: {
            model: join(dir, "model.int8.onnx"),
            useInverseTextNormalization: 1,
          },
          tokens: join(dir, "tokens.txt"),
          numThreads: 2,
          provider: "cpu",
          debug: 0,
        },
      });

      const wave = sh.readWave(wavPath) as { samples: Float32Array; sampleRate: number };
      const sampleRate: number = wave.sampleRate;
      const durationSec = wave.samples.length / sampleRate;
      const windowSamples = WINDOW_SEC * sampleRate;

      const allWords: TranscriptWord[] = [];
      let firstLang = "";

      for (let start = 0; start < wave.samples.length; start += windowSamples) {
        if (signal?.aborted) throw new Error("transcription cancelled");
        const chunk = wave.samples.subarray(start, Math.min(start + windowSamples, wave.samples.length));
        const offsetSec = start / sampleRate;
        const stream = recognizer.createStream();
        stream.acceptWaveform({ sampleRate, samples: chunk });
        recognizer.decode(stream);
        const result = recognizer.getResult(stream) as SherpaResult;
        if (!firstLang && result.lang) firstLang = result.lang.replace(/[<|>]/g, "");
        allWords.push(...tokensToWords(result, offsetSec, offsetSec + chunk.length / sampleRate));
        onProgress?.({
          fraction: Math.min(1, (start + chunk.length) / wave.samples.length),
          stage: "transcribing",
        });
      }

      onProgress?.({ fraction: 1, stage: "finalizing" });
      return {
        language: firstLang || "auto",
        segments: segmentWords(allWords),
        engine: this.id,
        durationSec,
      };
    } finally {
      await rm(wavPath, { force: true });
    }
  }
}
