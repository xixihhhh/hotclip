import { rebuildWords } from "../../shared/edit-transcript";
import type { TranscriptWord, Transcript, TranscribeOptions, TranscribeEngine } from "./types";
import { transcribeWindows } from "./windowed";
import { refineWordTimings, ALIGN_MIN_MATCH_FRAC } from "../align";

export const DEFAULT_QWEN_URL = "http://127.0.0.1:8766";
export interface QwenHealth {
  protocol: "hotclip-speech-v1";
  model: "Qwen/Qwen3-ASR-0.6B" | "Qwen/Qwen3-ASR-1.7B";
  aligner: boolean;
  device: string;
  revision: string;
}

/** Local means literal loopback, including redirects. Media never leaves this machine. */
export function localSpeechUrl(value = DEFAULT_QWEN_URL): string {
  const u = new URL(value);
  if (u.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(u.hostname) || u.username || u.password || u.search || u.hash || u.pathname !== "/") {
    throw new Error("qwen:loopback-required");
  }
  return u.origin;
}

async function request(url: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(`${localSpeechUrl(url)}${path}`, {
    method: body === undefined ? "GET" : "POST", redirect: "error",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(body === undefined ? 3000 : 600000)]) : AbortSignal.timeout(body === undefined ? 3000 : 600000),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`qwen:http-${response.status}`); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("qwen:empty-response");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 2 * 1024 * 1024) throw new Error("qwen:response-too-large");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function qwenHealth(url = DEFAULT_QWEN_URL, signal?: AbortSignal): Promise<QwenHealth> {
  const value = await request(url, "/health", undefined, signal) as QwenHealth;
  if (value?.protocol !== "hotclip-speech-v1" || !["Qwen/Qwen3-ASR-0.6B", "Qwen/Qwen3-ASR-1.7B"].includes(value.model) ||
      typeof value.aligner !== "boolean" || typeof value.revision !== "string" || typeof value.device !== "string") throw new Error("qwen:incompatible-service");
  return value;
}

export function parseQwenWords(value: unknown, duration: number, offset = 0, skipZeroDuration = false): TranscriptWord[] {
  if (!Array.isArray(value) || value.length > 20000) throw new Error("qwen:invalid-words");
  let end = 0;
  return value.flatMap((raw) => {
    const w = raw as { text: string; start: number; end: number };
    if (!w || typeof w.text !== "string" || !w.text.trim() || w.text.length > 8000 || !Number.isFinite(w.start) || !Number.isFinite(w.end) ||
        w.start < end - 0.025 || w.start < 0 || w.end < w.start || (!skipZeroDuration && w.end === w.start) || w.end > duration + 0.1) throw new Error("qwen:invalid-timestamps");
    // The aligner can emit a zero-length function word (e.g. English "a").
    // It is not a timing anchor; the caller retains its text and marks interpolation.
    if (skipZeroDuration && w.end === w.start) return [];
    const startSec = Math.max(end, Math.min(duration, w.start));
    const endSec = Math.min(duration, w.end);
    if (endSec <= startSec) throw new Error("qwen:invalid-timestamps");
    end = endSec;
    return [{ text: w.text, startSec: offset + startSec, endSec: offset + endSec, timingSource: "aligned" as const }];
  });
}

function pcmBody(samples: Float32Array): { pcm: string; sampleRate: number } {
  const buffer = Buffer.alloc(samples.length * 4);
  for (let i = 0; i < samples.length; i++) buffer.writeFloatLE(samples[i], i * 4);
  return { pcm: buffer.toString("base64"), sampleRate: 16000 };
}

export async function qwenAlign(url: string, samples: Float32Array, text: string, language: string, signal?: AbortSignal): Promise<TranscriptWord[]> {
  const result = await request(url, "/align", { ...pcmBody(samples), text, language }, signal) as { words: unknown };
  return parseQwenWords(result.words, samples.length / 16000, 0, true);
}

export function qwenTranscriptWords(text: string, stamps: unknown, start: number, end: number): TranscriptWord[] {
  const estimated = rebuildWords(text, start, end).map((word) => ({ ...word, timingSource: "estimated" as const }));
  if (stamps === undefined) return estimated;
  const refs = parseQwenWords(stamps, end - start, start, true);
  if (text.trim() && !refs.length) return estimated;
  const refined = refineWordTimings(estimated, refs);
  if (refined.matchedFrac < ALIGN_MIN_MATCH_FRAC || refined.words.some((w) => w.endSec > end || w.startSec < start)) return estimated;
  return refined.words;
}

export class QwenLocalEngine implements TranscribeEngine {
  id = "qwen3-local";
  label = "Qwen3-ASR (本地服务 · 可选)";
  constructor(private url = DEFAULT_QWEN_URL) { localSpeechUrl(url); }
  async isReady(): Promise<boolean> { return qwenHealth(this.url).then(() => true, () => false); }
  async transcribe(filePath: string, options: TranscribeOptions = {}): Promise<Transcript> {
    const health = await qwenHealth(this.url, options.signal);
    return transcribeWindows(filePath, this.id, JSON.stringify([health, this.url, "qwen-v2"]), options, async (samples, start, end) => {
      const result = await request(this.url, "/transcribe", { ...pcmBody(samples), language: options.language }, options.signal) as { text: string; language: string; words?: unknown };
      if (typeof result.text !== "string" || result.text.length > 8000 || typeof result.language !== "string") throw new Error("qwen:invalid-transcript");
      const words = qwenTranscriptWords(result.text, result.words, start, end);
      return { words, language: result.language };
    });
  }
}
