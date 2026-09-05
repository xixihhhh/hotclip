import { open } from "fs/promises";
import { extname } from "path";
import type { Transcript } from "../shared/api-types";
import { parseSubtitleTranscript, validateSubtitleInput, SUBTITLE_IMPORT_MAX_BYTES, type SubtitleFormat } from "../shared/subtitle-import";
import { probeMedia } from "./probe";

/** Both desktop and headless import bind subtitle timecodes to this source. */
export async function importSubtitleText(videoPath: string, text: string, format: SubtitleFormat, signal?: AbortSignal): Promise<Transcript> {
  signal?.throwIfAborted();
  validateSubtitleInput(text, format);
  const media = await probeMedia(videoPath);
  signal?.throwIfAborted();
  return parseSubtitleTranscript(text, format, media.durationSec);
}

/** Explicit sidecar only: never discover a possibly unrelated transcript. */
export async function importSubtitleFile(videoPath: string, subtitlePath: string, signal?: AbortSignal): Promise<Transcript> {
  signal?.throwIfAborted();
  const format = extname(subtitlePath).slice(1).toLowerCase();
  if (format !== "srt" && format !== "vtt") throw new Error("subtitle-import:format:0");
  const file = await open(subtitlePath, "r");
  let text: string;
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("subtitle-import:format:0");
    if (info.size > SUBTITLE_IMPORT_MAX_BYTES) throw new Error("subtitle-import:size:0");
    // Bounded even if the file grows after stat; do not allocate an unbounded read.
    const bytes = Buffer.alloc(SUBTITLE_IMPORT_MAX_BYTES + 1);
    let used = 0;
    while (used < bytes.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(bytes, used, bytes.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > SUBTITLE_IMPORT_MAX_BYTES) throw new Error("subtitle-import:size:0");
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used)); }
    catch { throw new Error("subtitle-import:encoding:0"); }
  } finally {
    await file.close();
  }
  return importSubtitleText(videoPath, text, format, signal);
}
