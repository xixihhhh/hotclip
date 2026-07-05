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

/**
 * 9:16 output — caption baseline lands at ~71% of frame height, inside the
 * 62-72% band that clears every major platform's UI overlays (Douyin/Kuaishou
 * bottom bars, TikTok's taller action zone, Shorts' right rail).
 */
export const VERTICAL_LAYOUT: AssLayout = {
  playResX: 1080,
  playResY: 1920,
  fontSize: 78,
  marginV: 560,
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

/**
 * The bundled caption font (resources/fonts/SourceHanSansSC-Bold.otf, OFL).
 * Shipping our own font + passing fontsdir to the subtitles filter is the only
 * way to get identical CJK rendering on every machine — fontconfig fallback is
 * a lottery (missing zh fonts render as tofu boxes on bare Windows installs).
 */
export const BUNDLED_FONT_FAMILY = "Source Han Sans SC";

/** Bundled font first; per-platform system font as a fontconfig fallback. */
export function defaultFontName(platform: NodeJS.Platform = process.platform): string {
  void platform;
  return BUNDLED_FONT_FAMILY;
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

const HARD_PUNCT_END = /[。!?!?…]$/;
/**
 * Clause-boundary punctuation (comma / ideographic comma / semicolon / colon).
 * The ASR punctuation model places these at real syntactic pauses, so breaking
 * here is the keyless equivalent of an LLM-inserted semantic [br] — no extra
 * model call, no cloud key, works on every clip. Only fires once the line is
 * substantial (SOFT_BREAK_MIN_FRAC of the width cap) so short clauses still
 * merge into one readable line instead of fragmenting on every comma.
 */
const SOFT_PUNCT_END = /[，,、；;：]$/;
const SOFT_BREAK_MIN_FRAC = 0.5;
/**
 * Structural / aspectual / modal particles a Chinese line may safely end on.
 * When a comma-free clause is longer than the width cap it would otherwise
 * split mid-phrase; backing the break up to the nearest such particle keeps
 * phrases intact ("…十几块的 / 到底…" not "…十几块的到 / 底…"). Keyless stand-in
 * for an LLM semantic break on long clauses; falls back to a width cut when the
 * run has no particle either.
 */
const BREAK_AFTER_PARTICLE = /(的|了|着|过|地|得|吧|呢|吗|啊|嘛|呀)$/;
const LOOKBACK_MIN_FRAC = 0.35;

/**
 * On a width-overflow break, find the latest word inside `line` that ends on a
 * particle boundary and still leaves a substantial head (≥ LOOKBACK_MIN_FRAC of
 * the cap). Returns the break-after index, or -1 when no good boundary exists.
 */
function particleBreakIndex(line: TranscriptWord[], maxLineUnits: number): number {
  const min = maxLineUnits * LOOKBACK_MIN_FRAC;
  let prefix = 0;
  const prefixUnits = line.map((wd) => (prefix += widthUnits(wd.text)));
  for (let k = line.length - 2; k >= 0; k--) {
    if (prefixUnits[k] >= min && BREAK_AFTER_PARTICLE.test(line[k].text)) return k;
  }
  return -1;
}

/**
 * Break the word stream into caption lines: width cap, silence-gap breaks,
 * sentence-final punctuation breaks, clause-boundary (soft-punctuation) breaks
 * once a line is substantial, and forced breaks (e.g. jump-cut splice points,
 * where the silence that used to separate sentences no longer exists).
 */
export function groupWordsIntoLines(
  words: TranscriptWord[],
  maxLineUnits: number,
  forcedBreaks: number[] = []
): TranscriptWord[][] {
  const GAP_BREAK_SEC = 0.8;
  const softBreakMin = maxLineUnits * SOFT_BREAK_MIN_FRAC;
  const lines: TranscriptWord[][] = [];
  let line: TranscriptWord[] = [];
  let units = 0;
  let bi = 0;
  const flush = (): void => {
    if (line.length > 0) lines.push(line);
    line = [];
    units = 0;
  };
  for (const w of words) {
    let forced = false;
    while (bi < forcedBreaks.length && w.startSec >= forcedBreaks[bi] - 1e-6) {
      forced = true;
      bi++;
    }
    const wUnits = widthUnits(w.text);
    const prev = line[line.length - 1];
    const gapBreak = prev !== undefined && w.startSec - prev.endSec > GAP_BREAK_SEC;
    const overflow = units + wUnits > maxLineUnits;
    if (line.length > 0 && (forced || overflow || gapBreak)) {
      // Width-only overflow backs the break up to the nearest particle boundary
      // so a long comma-free clause doesn't split mid-phrase; the trailing words
      // carry onto the next line with `w`. Forced (jump-cut) and silence-gap
      // breaks are real boundaries — honor them exactly, no look-back.
      let carry: TranscriptWord[] = [];
      if (overflow && !forced && !gapBreak) {
        const k = particleBreakIndex(line, maxLineUnits);
        if (k >= 0 && k < line.length - 1) carry = line.splice(k + 1);
      }
      flush();
      if (carry.length > 0) {
        line = carry;
        units = carry.reduce((s, c) => s + widthUnits(c.text), 0);
      }
    }
    line.push(w);
    units += wUnits;
    // Hard sentence end always flushes; a clause boundary flushes only once the
    // line already carries enough to stand on its own (avoids one-word lines).
    if (HARD_PUNCT_END.test(w.text)) flush();
    else if (SOFT_PUNCT_END.test(w.text) && units >= softBreakMin) flush();
  }
  flush();
  return lines;
}

/**
 * Merge each run of words covered by a keyword into ONE word so line breaking
 * can never split a keyword (which would silently kill its highlight).
 */
export function mergeKeywordWords(words: TranscriptWord[], keywords: string[]): TranscriptWord[] {
  if (keywords.length === 0 || words.length === 0) return words;
  const spans: Array<{ from: number; to: number }> = [];
  let joined = "";
  for (let i = 0; i < words.length; i++) {
    const from = joined.length;
    joined += words[i].text;
    spans.push({ from, to: joined.length });
    if (needsSpaceAfter(words[i].text, words[i + 1]?.text)) joined += " ";
  }
  const haystack = joined.toLowerCase();
  const covered = new Array<boolean>(words.length).fill(false);
  for (const kw of keywords) {
    const needle = kw.trim().toLowerCase();
    if (!needle) continue;
    for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
      const to = at + needle.length;
      spans.forEach((s, i) => {
        if (s.from < to && s.to > at) covered[i] = true;
      });
    }
  }
  const out: TranscriptWord[] = [];
  for (let i = 0; i < words.length; i++) {
    const prev = out[out.length - 1];
    if (covered[i] && i > 0 && covered[i - 1] && prev) {
      const space = needsSpaceAfter(prev.text, words[i].text) ? " " : "";
      prev.text += space + words[i].text;
      prev.endSec = words[i].endSec;
    } else {
      out.push({ ...words[i] });
    }
  }
  return out;
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

/** ASS colors are &HAABBGGRR. Highlight = flame orange, base = white. */
const EMBER_COLOR = "&H000D6EFF"; // #FF6E0D
const WHITE_COLOR = "&H00FFFFFF";
const OUTLINE_COLOR = "&H00201510";
/** Inline override forms (no alpha byte). */
const EMBER_INLINE = "&H0D6EFF&";
const WHITE_INLINE = "&HFFFFFF&";

/**
 * Caption style presets (2026 short-video canon):
 *  - karaoke: whole line visible, words light up as spoken
 *  - keyword: whole line visible, LLM-picked keywords tinted & slightly larger
 *  - pop: 2-4 character chunks appear one at a time with a bounce
 */
export type CaptionStyle = "karaoke" | "keyword" | "pop";

export interface CaptionOptions {
  fontName?: string;
  /** Verbatim keywords to emphasize (keyword style). */
  keywords?: string[];
  /** Timeline positions that must start a new line/chunk (jump-cut splices). */
  forcedBreaks?: number[];
  /** Burn the clip title into the top safe zone for the whole clip. */
  titleCard?: { text: string; durationSec: number };
}

/** Title block sits below platform top overlays (~8% of height) with air. */
function titleMarginV(layout: AssLayout): number {
  return Math.round(layout.playResY * 0.1);
}

function assHeader(style: CaptionStyle, layout: AssLayout, fontName: string): string[] {
  // karaoke: Primary = sung color, Secondary = not-yet-sung; others: plain white
  const primary = style === "karaoke" ? EMBER_COLOR : WHITE_COLOR;
  const fontSize = style === "pop" ? Math.round(layout.fontSize * 1.45) : layout.fontSize;
  const titleSize = Math.round(layout.fontSize * 0.82);
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
    `Style: Caption,${fontName},${fontSize},${primary},${WHITE_COLOR},${OUTLINE_COLOR},&H7F000000,-1,0,0,0,100,100,0,0,1,${layout.outline},0,2,${layout.marginH},${layout.marginH},${layout.marginV},1`,
    // title card: opaque-box style (BorderStyle=3) → soft dark plate behind text
    `Style: Title,${fontName},${titleSize},${WHITE_COLOR},${WHITE_COLOR},&H73000000,&H73000000,-1,0,0,0,100,100,0,0,3,12,0,8,${layout.marginH},${layout.marginH},${titleMarginV(layout)},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
}

/** Manual title wrapping (no libunibreak in ffmpeg-static): ~14 CJK units/line, max 2 lines. */
export function wrapTitle(text: string, maxUnits = 28): string {
  const chars = Array.from(escapeAssText(text));
  let units = 0;
  let breakAt = -1;
  for (let i = 0; i < chars.length; i++) {
    units += CJK_RE.test(chars[i]) ? 2 : 1;
    if (units > maxUnits && breakAt === -1) breakAt = i;
  }
  if (breakAt === -1) return chars.join("");
  return `${chars.slice(0, breakAt).join("")}\\N${chars.slice(breakAt).join("")}`;
}

function dialogue(startSec: number, endSec: number, text: string): string {
  return `Dialogue: 0,${toAssTime(startSec)},${toAssTime(endSec)},Caption,,0,0,0,,${text}`;
}

/**
 * Keyword style: mark which words fall inside any keyword occurrence, then
 * wrap those runs with a color+scale override. Matching runs on the joined
 * line text (same spacing rules as display), case-insensitive.
 */
export function keywordText(line: TranscriptWord[], keywords: string[]): string {
  // joined text + each word's [start,end) position inside it
  const spans: Array<{ from: number; to: number }> = [];
  let joined = "";
  for (let i = 0; i < line.length; i++) {
    const from = joined.length;
    joined += line[i].text;
    spans.push({ from, to: joined.length });
    if (needsSpaceAfter(line[i].text, line[i + 1]?.text)) joined += " ";
  }
  const haystack = joined.toLowerCase();
  const covered = new Array<boolean>(line.length).fill(false);
  for (const kw of [...new Set(keywords)].sort((a, b) => b.length - a.length)) {
    const needle = kw.trim().toLowerCase();
    if (!needle) continue;
    for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
      const to = at + needle.length;
      spans.forEach((s, i) => {
        if (s.from < to && s.to > at) covered[i] = true;
      });
    }
  }
  const parts: string[] = [];
  for (let i = 0; i < line.length; i++) {
    if (covered[i] && (i === 0 || !covered[i - 1])) parts.push(`{\\c${EMBER_INLINE}\\fscx108\\fscy108}`);
    if (!covered[i] && i > 0 && covered[i - 1]) parts.push(`{\\c${WHITE_INLINE}\\fscx100\\fscy100}`);
    parts.push(escapeAssText(line[i].text));
    if (needsSpaceAfter(line[i].text, line[i + 1]?.text)) parts.push(" ");
  }
  return parts.join("");
}

/** Pop bounce: start small, overshoot, settle — three-stage \t chain. */
const POP_INTRO = "{\\fscx60\\fscy60\\t(0,90,\\fscx135\\fscy135)\\t(90,200,\\fscx100\\fscy100)}";

/** Pop chunks: 2-4 CJK chars (or 1-2 latin words) shown one at a time. */
const POP_MAX_UNITS = 8;

/**
 * Build a complete ASS document for one clip in the given style. Word
 * timestamps are absolute (source time); `clipStartSec` shifts them.
 */
export function buildCaptionAss(
  words: TranscriptWord[],
  clipStartSec: number,
  layout: AssLayout,
  style: CaptionStyle = "karaoke",
  options: CaptionOptions = {}
): string {
  const fontName = options.fontName ?? defaultFontName();
  const events: string[] = [];

  if (options.titleCard && options.titleCard.text.trim()) {
    const tc = options.titleCard;
    events.push(
      `Dialogue: 1,${toAssTime(0)},${toAssTime(tc.durationSec)},Title,,0,0,0,,${wrapTitle(tc.text)}`
    );
  }

  const forcedBreaks = options.forcedBreaks ?? [];
  if (style === "pop") {
    const units = groupWordsIntoLines(words, POP_MAX_UNITS, forcedBreaks);
    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      const start = unit[0].startSec - clipStartSec;
      const next = units[i + 1]?.[0].startSec;
      const end = (next !== undefined ? next : unit[unit.length - 1].endSec + 0.2) - clipStartSec;
      const text = unit
        .map((w, j) => escapeAssText(w.text) + (needsSpaceAfter(w.text, unit[j + 1]?.text) ? " " : ""))
        .join("");
      events.push(dialogue(start, end, POP_INTRO + text));
    }
  } else {
    // keyword style: fuse keyword runs first so line breaks can't split them
    const lineWords = style === "keyword" ? mergeKeywordWords(words, options.keywords ?? []) : words;
    const lines = groupWordsIntoLines(lineWords, layout.maxLineUnits, forcedBreaks).filter((l) => l.length > 0);
    for (const line of lines) {
      const start = line[0].startSec - clipStartSec;
      const end = line[line.length - 1].endSec - clipStartSec;
      const text = style === "karaoke" ? karaokeText(line) : keywordText(line, options.keywords ?? []);
      events.push(dialogue(start, end, text));
    }
  }

  return [...assHeader(style, layout, fontName), ...events, ""].join("\n");
}

/** Back-compat wrapper (karaoke style). */
export function buildKaraokeAss(
  words: TranscriptWord[],
  clipStartSec: number,
  layout: AssLayout,
  fontName: string = defaultFontName()
): string {
  return buildCaptionAss(words, clipStartSec, layout, "karaoke", { fontName });
}
