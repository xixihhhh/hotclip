/**
 * Cloud ASR, international tier: ElevenLabs Scribe. Simplest possible cloud
 * integration — one multipart POST, native word-level timestamps, 90+
 * languages. We upload an EXTRACTED compressed mono audio track, never the
 * source video: privacy-minimal and ~100x smaller.
 */
import { join } from "path";
import { rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { resolveFfmpegPath } from "../binaries";
import { segmentWords } from "./segment";
import type { Transcript, TranscribeEngine, TranscribeOptions, TranscriptWord } from "./types";

const execFileAsync = promisify(execFile);

const DEFAULT_BASE_URL = "https://api.elevenlabs.io";

interface ScribeWord {
  text: string;
  start?: number;
  end?: number;
  type?: string;
}

export interface ScribeResponse {
  language_code?: string;
  text?: string;
  words?: ScribeWord[];
}

/** Map Scribe's word stream onto our timed-word shape (drops spacing tokens). */
export function parseScribeWords(res: ScribeResponse): TranscriptWord[] {
  const out: TranscriptWord[] = [];
  for (const w of res.words ?? []) {
    if (w.type === "spacing") continue;
    const text = (w.text ?? "").trim();
    if (!text) continue;
    const start = Number(w.start);
    const end = Number(w.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    out.push({ text, startSec: start, endSec: Math.max(end, start), timingSource: "native" });
  }
  return out;
}

export class ElevenLabsEngine implements TranscribeEngine {
  id = "elevenlabs-cloud";
  label = "ElevenLabs Scribe (云端 · 90+ 语种)";

  constructor(
    private apiKey: string,
    private baseUrl: string = DEFAULT_BASE_URL
  ) {}

  async isReady(): Promise<boolean> {
    return Boolean(this.apiKey);
  }

  async transcribe(filePath: string, options: TranscribeOptions = {}): Promise<Transcript> {
    const { onProgress, signal } = options;
    if (!this.apiKey) throw new Error("需要 ElevenLabs API Key / ElevenLabs API key required");

    // extract compact mono audio — never upload the raw video
    onProgress?.({ fraction: 0, stage: "decoding" });
    const audioPath = join(tmpdir(), `hotclip-${Date.now()}-upload.m4a`);
    try {
      await execFileAsync(
        resolveFfmpegPath(),
        ["-hide_banner", "-y", "-i", filePath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "48k", audioPath],
        { maxBuffer: 32 * 1024 * 1024 }
      );

      onProgress?.({ fraction: 0.2, stage: "transcribing" });
      const audio = await readFile(audioPath);
      const form = new FormData();
      form.append("model_id", "scribe_v2");
      form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/mp4" }), "audio.m4a");

      let res: Response;
      try {
        res = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/v1/speech-to-text`, {
          method: "POST",
          headers: { "xi-api-key": this.apiKey },
          body: form,
          signal,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`无法连接 ElevenLabs / cannot reach ElevenLabs: ${msg}`);
      }
      const bodyText = await res.text();
      if (!res.ok) {
        throw new Error(`ElevenLabs 转写失败 / transcription failed (HTTP ${res.status}): ${bodyText.slice(0, 300)}`);
      }
      let data: ScribeResponse;
      try {
        data = JSON.parse(bodyText);
      } catch {
        throw new Error(`ElevenLabs 返回非 JSON / non-JSON response: ${bodyText.slice(0, 200)}`);
      }

      onProgress?.({ fraction: 0.9, stage: "finalizing" });
      const words = parseScribeWords(data);
      if (words.length === 0) throw new Error("云端未返回词级时间戳 / no word timestamps returned");
      return {
        language: (data.language_code ?? "auto").slice(0, 5),
        segments: segmentWords(words),
        engine: this.id,
        durationSec: words[words.length - 1].endSec,
      };
    } finally {
      await rm(audioPath, { force: true });
    }
  }
}
