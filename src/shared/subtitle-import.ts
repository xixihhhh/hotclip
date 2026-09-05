/** Plain-text subtitle interchange. No DOM, model, network or filesystem access. */
import type { Transcript, TranscriptSegment } from "./api-types";
import { rebuildWords } from "./edit-transcript";

export type SubtitleFormat = "srt" | "vtt";
export const SUBTITLE_IMPORT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_CUES = 20_000;
const MAX_WORDS = 100_000;
const MAX_CUE_CHARS = 8_000;

export const SUBTITLE_IMPORT_ERROR_CODES = [
  "format", "size", "encoding", "cue", "empty", "overlap", "range", "limit", "mapped",
] as const;
export type SubtitleImportErrorCode = typeof SUBTITLE_IMPORT_ERROR_CODES[number];

function fail(code: SubtitleImportErrorCode, cue = 0): never {
  throw new Error(`subtitle-import:${code}:${cue}`);
}

/** Works with both direct errors and Electron's IPC error wrapper. */
export function subtitleImportError(error: unknown): { code: SubtitleImportErrorCode; cue: number } | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = /subtitle-import:([a-z]+):(\d+)/.exec(message);
  return match && SUBTITLE_IMPORT_ERROR_CODES.includes(match[1] as SubtitleImportErrorCode)
    ? { code: match[1] as SubtitleImportErrorCode, cue: Number(match[2]) }
    : null;
}

/** Headless clients get recovery advice as well as the stable machine code. */
export function describeSubtitleImportError(error: unknown): string {
  const issue = subtitleImportError(error);
  if (!issue) return error instanceof Error ? error.message : String(error);
  const advice: Record<SubtitleImportErrorCode, string> = {
    format: "Choose a UTF-8 .srt or .vtt file.",
    size: "The subtitle file exceeds 5 MB; export a smaller transcript.",
    encoding: "Save the subtitle file as UTF-8 and retry.",
    cue: "Check cue text, timestamp syntax and blank lines between cues.",
    empty: "The file has no subtitle cues.",
    overlap: "Export a single chronological transcript track without overlapping cues.",
    range: "Subtitle times exceed the source duration; choose subtitles aligned to this media file.",
    limit: "Import is limited to 20,000 cues, 100,000 words and 8,000 characters per cue.",
    mapped: "Export a standalone SRT/WebVTT aligned to this media, without a streaming timestamp map.",
  };
  return `subtitle-import:${issue.code}:${issue.cue} ${advice[issue.code]}${issue.cue ? ` Cue ${issue.cue}.` : ""}`;
}

export function validateSubtitleInput(text: unknown, format: unknown): asserts text is string {
  if (format !== "srt" && format !== "vtt") fail("format");
  if (typeof text !== "string") fail("format");
  if (text.length > SUBTITLE_IMPORT_MAX_BYTES || new TextEncoder().encode(text).length > SUBTITLE_IMPORT_MAX_BYTES) fail("size");
  if (text.includes("\u0000") || text.includes("\uFFFD")) fail("encoding");
}

function timestamp(value: string, format: SubtitleFormat): number | null {
  const pattern = format === "srt"
    ? /^(\d{2,}):([0-5]\d):([0-5]\d)[,.](\d{3})$/
    : /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/;
  const match = pattern.exec(value);
  if (!match) return null;
  const ms = (Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000 + Number(match[4]);
  return Number.isSafeInteger(ms) ? ms / 1000 : null;
}

/** Strip presentation only, then decode entities once so escaped text stays text. */
function cueText(payload: string): string {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", lrm: "", rlm: "" };
  return payload
    .replace(/<rt\b[^>]*>[\s\S]*?<\/rt>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?[a-z][^>]*>|<\d{2,}:[\d:.]+>/gi, "")
    .replace(/\{\\[^}]*\}/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|lrm|rlm);/gi, (entity, name: string) => {
      if (!name.startsWith("#")) return entities[name.toLowerCase()] ?? entity;
      const n = /^#x/i.test(name) ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
    })
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Import a single transcript track bound to the probed source duration. Cue
 * boundaries are preserved; all within-cue word times are explicitly estimated.
 * Reject ambiguous/overlapping/mapped tracks instead of silently losing dialogue.
 */
export function parseSubtitleTranscript(text: string, format: SubtitleFormat, durationSec: number): Transcript {
  validateSubtitleInput(text, format);
  if (!Number.isFinite(durationSec) || durationSec <= 0) fail("range");
  const source = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (!source) fail("empty");
  const blocks = source.split(/\n[\t ]*\n+/);
  if (format === "vtt") {
    if (!/^WEBVTT(?:[\t ]|$)/.test(blocks[0].split("\n")[0])) fail("format");
    // HLS clock mappings require the matching media timeline; standalone media
    // cannot establish that relationship, including when LOCAL happens to be 0.
    if (/^X-TIMESTAMP-MAP[=:]/m.test(source)) fail("mapped");
    if (blocks[0].includes("-->")) fail("cue", 1);
    blocks.shift();
  }

  const segments: TranscriptSegment[] = [];
  let totalWords = 0;
  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (format === "vtt" && /^(NOTE(?:[\t ]|$)|STYLE$|REGION$)/.test(lines[0])) continue;
    const cue = segments.length + 1;
    if (cue > MAX_CUES) fail("limit", cue);
    const timingIndex = lines[0].includes("-->") ? 0 : 1;
    if (timingIndex === 1 && format === "srt" && !/^\d+$/.test(lines[0])) fail("cue", cue);
    const timing = /^(\S+)\s+-->\s+(\S+)(?:[\t ]+(.*))?$/.exec(lines[timingIndex]?.trim() ?? "");
    if (!timing || (format === "srt" && timing[3])) fail("cue", cue);
    const startSec = timestamp(timing[1], format);
    const endSec = timestamp(timing[2], format);
    if (startSec === null || endSec === null || endSec <= startSec) fail("cue", cue);
    if (startSec >= durationSec || endSec > durationSec + 0.001) fail("range", cue);
    if (segments.length && startSec < segments[segments.length - 1].endSec) fail("overlap", cue);
    const payload = lines.slice(timingIndex + 1).join("\n");
    if (payload.length > MAX_CUE_CHARS) fail("limit", cue);
    // Missing block separators must never turn a following timestamp into speech.
    if (payload.includes("-->")) fail("cue", cue);
    const clean = cueText(payload);
    if (!clean) fail("cue", cue);
    const words = rebuildWords(clean, startSec, Math.min(endSec, durationSec))
      .map((word) => ({ ...word, timingSource: "estimated" as const }));
    totalWords += words.length;
    if (totalWords > MAX_WORDS) fail("limit", cue);
    segments.push({ id: cue, startSec, endSec: Math.min(endSec, durationSec), text: clean, words });
  }
  if (!segments.length) fail("empty");
  // SRT/VTT have no reliable language declaration. Downstream text-based
  // language inference already handles "auto" without inventing an ASR result.
  return { language: "auto", engine: `subtitle-${format}`, durationSec, segments };
}
