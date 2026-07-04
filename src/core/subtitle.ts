/**
 * Karaoke caption generation: word-level transcript timestamps → an ASS file
 * with per-word `\k` highlighting, burned into clips via ffmpeg's subtitles
 * filter (libass). Everything here is a pure string builder — unit-testable
 * without ffmpeg; only the caller touches the filesystem.
 */
import type { Transcript, TranscriptWord } from "../shared/api-types";

export interface AssLayout {
  playResX: number;
  playResY: number;
  fontSize: number;
  /** Distance from the bottom edge to the caption block. */
  marginV: number;
  marginH: number;
  outline: number;
  /** Max visual width units per line (CJK char = 2 units, latin char = 1). */
  maxLineUnits: number;
}

/** 9:16 output — captions sit above the bottom UI zone of short-video apps. */
export const VERTICAL_LAYOUT: AssLayout = {
  playResX: 1080,
  playResY: 1920,
  fontSize: 78,
  marginV: 420,
  marginH: 60,
  outline: 4,
  maxLineUnits: 22,
};

/** 16:9 output — classic bottom-center captions. */
export const HORIZONTAL_LAYOUT: AssLayout = {
  playResX: 1920,
  playResY: 1080,
  fontSize: 66,
  marginV: 90,
  marginH: 120,
  outline: 3,
  maxLineUnits: 36,
};

/** CJK-capable system font per platform; libass falls back via fontconfig if absent. */
export function defaultFontName(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "PingFang SC";
  if (platform === "win32") return "Microsoft YaHei";
  return "Noto Sans CJK SC";
}

const CJK_RE = /[぀-ヿ㐀-鿿豈-﫿가-힯]/;

/** Visual width units of a token: CJK chars count double. */
function widthUnits(text: string): number {
  let units = 0;
  for (const ch of text) units += CJK_RE.test(ch) ? 2 : 1;
  return units;
}

/** Pull the words a clip covers out of the full transcript (by word midpoint). */
export function sliceWords(transcript: Transcript, startSec: number, endSec: number): TranscriptWord[] {
  const out: TranscriptWord[] = [];
  for (const seg of transcript.segments) {
    if (seg.endSec < startSec || seg.startSec > endSec) continue;
    for (const w of seg.words) {
      const mid = (w.startSec + w.endSec) / 2;
      if (mid >= startSec && mid <= endSec) out.push(w);
    }
  }
  return out.sort((a, b) => a.startSec - b.startSec);
}

/** Break the word stream into caption lines: width cap + silence-gap breaks. */
export function groupWordsIntoLines(words: TranscriptWord[], maxLineUnits: number): TranscriptWord[][] {
  const GAP_BREAK_SEC = 0.8;
  const lines: TranscriptWord[][] = [];
  let line: TranscriptWord[] = [];
  let units = 0;
  for (const w of words) {
    const wUnits = widthUnits(w.text);
    const prev = line[line.length - 1];
    const gapBreak = prev !== undefined && w.startSec - prev.endSec > GAP_BREAK_SEC;
    if (line.length > 0 && (units + wUnits > maxLineUnits || gapBreak)) {
      lines.push(line);
      line = [];
      units = 0;
    }
    line.push(w);
    units += wUnits;
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

/** ASS timestamp: H:MM:SS.CC (centiseconds). */
export function toAssTime(sec: number): string {
  const clamped = Math.max(0, sec);
  const cs = Math.round(clamped * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

/** ASS override braces / backslashes would corrupt the event line — strip them. */
function escapeAssText(text: string): string {
  return text.replace(/[{}\\]/g, "").replace(/[\r\n]+/g, " ");
}

/** Latin↔latin token boundaries need a space; CJK joins bare. */
function needsSpaceAfter(current: string, next: string | undefined): boolean {
  if (!next) return false;
  return !CJK_RE.test(current.slice(-1)) && !CJK_RE.test(next.charAt(0));
}

/**
 * One line of karaoke text: `{\k<cs>}word` per word. Each word's sweep runs
 * until the NEXT word starts (absorbing inter-word silence) so the highlight
 * moves continuously instead of stalling mid-line.
 */
function karaokeText(line: TranscriptWord[]): string {
  const parts: string[] = [];
  for (let i = 0; i < line.length; i++) {
    const w = line[i];
    const next = line[i + 1];
    const sweepEnd = next ? next.startSec : w.endSec;
    const cs = Math.max(1, Math.round((sweepEnd - w.startSec) * 100));
    const space = needsSpaceAfter(w.text, next?.text) ? " " : "";
    parts.push(`{\\k${cs}}${escapeAssText(w.text)}${space}`);
  }
  return parts.join("");
}

/** ASS colors are &HAABBGGRR. Sung = flame orange, unsung = white. */
const SUNG_COLOR = "&H000D6EFF"; // #FF6E0D
const UNSUNG_COLOR = "&H00FFFFFF";
const OUTLINE_COLOR = "&H00201510";

/**
 * Build a complete ASS document for one clip. Word timestamps are absolute
 * (source-video time); `clipStartSec` shifts them to clip-relative time.
 */
export function buildKaraokeAss(
  words: TranscriptWord[],
  clipStartSec: number,
  layout: AssLayout,
  fontName: string = defaultFontName()
): string {
  const lines = groupWordsIntoLines(words, layout.maxLineUnits);
  const events = lines
    .filter((line) => line.length > 0)
    .map((line) => {
      const start = toAssTime(line[0].startSec - clipStartSec);
      const end = toAssTime(line[line.length - 1].endSec - clipStartSec);
      return `Dialogue: 0,${start},${end},Karaoke,,0,0,0,,${karaokeText(line)}`;
    });

  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${layout.playResX}`,
    `PlayResY: ${layout.playResY}`,
    "ScaledBorderAndShadow: yes",
    "WrapStyle: 2",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Karaoke,${fontName},${layout.fontSize},${SUNG_COLOR},${UNSUNG_COLOR},${OUTLINE_COLOR},&H7F000000,-1,0,0,0,100,100,0,0,1,${layout.outline},0,2,${layout.marginH},${layout.marginH},${layout.marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}
