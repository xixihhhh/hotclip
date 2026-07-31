/**
 * Generic sherpa-onnx offline engine runner. Every local model tier
 * (SenseVoice / Paraformer / FireRedASR…) shares the same pipeline:
 * ensure models → extract 16k f32le samples → windowed decode with token timestamps →
 * optional punctuation restoration → sentence segmentation.
 * A tier is described by a spec; adding a model = adding a spec.
 */
import { join } from "path";
import { rm } from "fs/promises";
import { tmpdir } from "os";
import { resolveFfmpegPath } from "../binaries";
import {
  ensureModel,
  extractPcmF32le16k,
  isModelInstalled,
  modelDir,
  readF32leSamples,
  PUNCT_MODEL,
  type ModelAsset,
} from "../models";
import { toAnsiSafeDir } from "../win-ansi-path";
import { segmentWords, joinWords } from "./segment";
import { applyPunctuation } from "./punctuate";
import type { Transcript, TranscribeEngine, TranscribeOptions, TranscriptWord } from "./types";

/** Window length per decode call; offline models handle ≤30s comfortably. */
const WINDOW_SEC = 28;

export interface SherpaResult {
  text: string;
  tokens?: string[];
  timestamps?: number[];
  lang?: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let sherpa: any = null;
/** sherpa-onnx-node is a native addon — require lazily so importing core stays cheap. */
export function loadSherpa(): any {
  if (!sherpa) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sherpa = require("sherpa-onnx-node");
  }
  return sherpa;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Convert one window's sherpa result into timed words offset to absolute time.
 * Engines emit per-token start times; each token's end is the next token's
 * start (last token gets +0.3s tail).
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

export interface SherpaEngineSpec {
  id: string;
  label: string;
  asset: ModelAsset;
  /** sherpa OfflineRecognizer modelConfig for this tier (paths inside `dir`). */
  buildModelConfig(dir: string): Record<string, unknown>;
  /** Fixed language, or a reader that pulls it from the first decode result. */
  language: string | ((result: SherpaResult) => string | undefined);
  /** Restore punctuation via CT-Transformer (models that emit none). */
  punctuate?: boolean;
  numThreads?: number;
}

export class SherpaOfflineEngine implements TranscribeEngine {
  id: string;
  label: string;

  constructor(
    private spec: SherpaEngineSpec,
    private modelsRoot: string
  ) {
    this.id = spec.id;
    this.label = spec.label;
  }

  async isReady(): Promise<boolean> {
    return isModelInstalled(this.modelsRoot, this.spec.asset);
  }

  async transcribe(filePath: string, options: TranscribeOptions = {}): Promise<Transcript> {
    const { onProgress, signal } = options;
    const spec = this.spec;

    onProgress?.({ fraction: 0, stage: "downloading-model" });
    const download = (p: { downloadedBytes: number; totalBytes: number; phase?: "download" | "extract" }): void =>
      onProgress?.({
        fraction: 0,
        stage: p.phase === "extract" ? "extracting-model" : "downloading-model",
        downloadedBytes: p.downloadedBytes,
        totalBytes: p.totalBytes,
      });
    await ensureModel(this.modelsRoot, spec.asset, download, signal);
    if (spec.punctuate) await ensureModel(this.modelsRoot, PUNCT_MODEL, download, signal);

    onProgress?.({ fraction: 0, stage: "decoding" });
    const pcmPath = join(tmpdir(), `hotclip-${Date.now()}-16k.f32le`);
    try {
      await extractPcmF32le16k(resolveFfmpegPath(), filePath, pcmPath);

      const sh = loadSherpa();
      // 模型文件由原生层自己打开(ANSI):Windows 中文路径先转 8.3 短路径(issue #4)
      const dir = await toAnsiSafeDir(modelDir(this.modelsRoot, spec.asset));
      const recognizer = new sh.OfflineRecognizer({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          ...spec.buildModelConfig(dir),
          tokens: join(dir, "tokens.txt"),
          numThreads: spec.numThreads ?? 2,
          provider: "cpu",
          debug: 0,
        },
      });
      const punct = spec.punctuate
        ? new sh.OfflinePunctuation({
            model: {
              ctTransformer: join(await toAnsiSafeDir(modelDir(this.modelsRoot, PUNCT_MODEL)), "model.int8.onnx"),
              numThreads: 1,
              provider: "cpu",
              debug: 0,
            },
          })
        : null;

      // 样本走 Node 读入(Unicode 路径免疫),不让原生层 readWave 自己开临时文件
      const samples = await readF32leSamples(pcmPath);
      const sampleRate = 16000;
      const durationSec = samples.length / sampleRate;
      const windowSamples = WINDOW_SEC * sampleRate;

      const allWords: TranscriptWord[] = [];
      let detectedLang = "";

      for (let start = 0; start < samples.length; start += windowSamples) {
        if (signal?.aborted) throw new Error("transcription cancelled");
        const chunk = samples.subarray(start, Math.min(start + windowSamples, samples.length));
        const offsetSec = start / sampleRate;
        const stream = recognizer.createStream();
        stream.acceptWaveform({ sampleRate, samples: chunk });
        recognizer.decode(stream);
        const result = recognizer.getResult(stream) as SherpaResult;
        if (!detectedLang && typeof spec.language === "function") {
          detectedLang = spec.language(result) ?? "";
        }
        let words = tokensToWords(result, offsetSec, offsetSec + chunk.length / sampleRate);
        if (punct && words.length > 0) {
          // per-window punctuation: ~28s of speech is ample sentence context
          words = applyPunctuation(words, punct.addPunct(joinWords(words)) as string);
        }
        allWords.push(...words);
        onProgress?.({
          fraction: Math.min(1, (start + chunk.length) / samples.length),
          stage: "transcribing",
        });
      }

      onProgress?.({ fraction: 1, stage: "finalizing" });
      return {
        language: typeof spec.language === "string" ? spec.language : detectedLang || "auto",
        segments: segmentWords(allWords),
        engine: this.id,
        durationSec,
      };
    } finally {
      await rm(pcmPath, { force: true });
    }
  }
}
