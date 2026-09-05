import { createHash, randomUUID } from "crypto";
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { extractPcmF32le16k } from "../models";
import { resolveFfmpegPath } from "../binaries";
import { probeMedia } from "../probe";
import { segmentWords } from "./segment";
import type { Transcript, TranscriptWord, TranscribeOptions } from "./types";

export const ASR_WINDOW_SEC = 28;
const RATE = 16000;
const WINDOW_BYTES = ASR_WINDOW_SEC * RATE * 4;
interface WindowResult { words: TranscriptWord[]; language?: string }

function validWindow(value: unknown, start: number, end: number): value is WindowResult {
  if (!value || typeof value !== "object") return false;
  const v = value as WindowResult;
  return (v.language === undefined || typeof v.language === "string") && Array.isArray(v.words) && v.words.length <= 20000 && v.words.every((w) =>
    typeof w.text === "string" && w.text.length <= 8000 && Number.isFinite(w.startSec) && Number.isFinite(w.endSec) &&
    w.startSec >= start - 0.001 && w.endSec >= w.startSec && w.endSec <= end + 0.001);
}

/** Model identity includes runtime/asset settings, not just the display name. */
export async function checkpointDirectory(root: string, file: string, identity: string): Promise<string> {
  const s = await stat(file);
  const key = createHash("sha256").update(JSON.stringify([resolve(file), s.size, s.mtimeMs, identity, ASR_WINDOW_SEC, 1])).digest("hex");
  return join(root, "partial", `run-${key}`);
}

async function prepareCheckpoint(dir: string, restart: boolean): Promise<void> {
  if (restart) await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const root = resolve(dir, "..");
  const entries = await readdir(root);
  const runs = await Promise.all(entries.filter((name) => /^run-[a-f0-9]{64}$/.test(name)).map(async (name) => {
    const path = join(root, name);
    return { path, time: (await stat(path)).mtimeMs };
  }));
  runs.sort((a, b) => b.time - a.time);
  await Promise.all(runs.slice(20).filter((entry) => entry.path !== dir).map((entry) => rm(entry.path, { recursive: true, force: true })));
}

/** PCM stays on disk. Only one 28-second window is resident; completed decode
 * windows survive cancellation/process exit. Cache faults only lose reuse. */
export async function transcribeWindows(
  filePath: string,
  engine: string,
  identity: string,
  options: TranscribeOptions,
  decode: (samples: Float32Array, startSec: number, endSec: number) => Promise<WindowResult>
): Promise<Transcript> {
  const { signal, onProgress } = options;
  signal?.throwIfAborted();
  const media = await probeMedia(filePath);
  if (!media.hasAudio || !Number.isFinite(media.durationSec) || media.durationSec <= 0) throw new Error("transcribe:no-audio");
  const count = Math.ceil(media.durationSec / ASR_WINDOW_SEC);
  let checkpoint: string | undefined;
  if (options.cacheDir) {
    checkpoint = await checkpointDirectory(options.cacheDir, filePath, `${identity}:${options.language ?? "auto"}`).catch(() => undefined);
    if (checkpoint) await prepareCheckpoint(checkpoint, Boolean(options.restart)).catch(() => { checkpoint = undefined; });
  }
  const allWords: TranscriptWord[] = [];
  let language = "auto";
  let resumed = 0;
  if (checkpoint) for (; resumed < count; resumed++) {
    signal?.throwIfAborted();
    const start = resumed * ASR_WINDOW_SEC;
    const end = Math.min(media.durationSec, start + ASR_WINDOW_SEC);
    const value: unknown = await readFile(join(checkpoint, `${resumed}.json`), "utf8").then(JSON.parse).catch(() => null);
    if (!validWindow(value, start, end)) break;
    allWords.push(...value.words);
    if (language === "auto" && value.language) language = value.language;
  }
  const report = (completed: number): void => onProgress?.({ fraction: completed / count, stage: "transcribing", completedWindows: completed, totalWindows: count, resumedWindows: resumed });
  report(resumed);
  if (resumed < count) {
    const temp = await mkdtemp(join(tmpdir(), "hotclip-asr-"));
    const pcm = join(temp, "audio.f32le");
    try {
      onProgress?.({ fraction: resumed / count, stage: "decoding", resumedWindows: resumed, totalWindows: count, completedWindows: resumed });
      const offset = resumed * ASR_WINDOW_SEC;
      await extractPcmF32le16k(resolveFfmpegPath(), filePath, pcm,
        offset > 0 ? { startSec: offset, durationSec: media.durationSec - offset } : undefined, media.audioStreamIndex, signal);
      const handle = await open(pcm, "r");
      try {
        const size = (await handle.stat()).size;
        for (let index = resumed; index < count; index++) {
          signal?.throwIfAborted();
          const position = (index - resumed) * WINDOW_BYTES;
          const length = Math.min(WINDOW_BYTES, size - position);
          if (length <= 0) {
            // Container durations can include a silent video tail. Do not invent speech.
            report(count);
            break;
          }
          const buffer = Buffer.alloc(length - length % 4);
          let read = 0;
          while (read < buffer.length) {
            const part = await handle.read(buffer, read, buffer.length - read, position + read);
            if (!part.bytesRead) throw new Error("transcribe:truncated-pcm");
            read += part.bytesRead;
          }
          const samples = new Float32Array(buffer.length / 4);
          for (let i = 0; i < samples.length; i++) samples[i] = buffer.readFloatLE(i * 4);
          const start = index * ASR_WINDOW_SEC;
          const end = Math.min(media.durationSec, start + samples.length / RATE);
          // Exact digital silence cannot contain speech. Do not ask a model to
          // invent text for it; quiet nonzero speech still goes through unchanged.
          const result = samples.every((sample) => sample === 0) ? { words: [] } : await decode(samples, start, end);
          if (!validWindow(result, start, end)) throw new Error("transcribe:invalid-window-timestamps");
          allWords.push(...result.words);
          if (language === "auto" && result.language) language = result.language;
          if (checkpoint) {
            const final = join(checkpoint, `${index}.json`);
            const tempFile = `${final}.${randomUUID()}.tmp`;
            await writeFile(tempFile, JSON.stringify(result), "utf8")
              .then(() => rename(tempFile, final)).catch(() => rm(tempFile, { force: true }).catch(() => {}));
          }
          report(index + 1);
        }
      } finally { await handle.close(); }
    } finally { await rm(temp, { recursive: true, force: true }); }
  }
  signal?.throwIfAborted();
  onProgress?.({ fraction: 1, stage: "finalizing", completedWindows: count, totalWindows: count, resumedWindows: resumed });
  return { language, segments: segmentWords(allWords), engine, durationSec: media.durationSec };
}
