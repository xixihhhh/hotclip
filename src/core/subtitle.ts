/**
 * Karaoke caption generation: word-level transcript timestamps → an ASS file
 * with per-word `\k` highlighting, burned into clips via ffmpeg's subtitles
 * filter (libass). Everything here is a pure string builder — unit-testable
 * without ffmpeg; only the caller touches the filesystem.
 */
import type { Transcript, TranscriptWord } from "../shared/api-types";
import { hexToAssColor, hexToAssInline, isValidHex } from "./brand";

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
 * How long a caption line may hold on screen waiting for the next one. A line
 * ends the instant its last word does, which flashes a blank frame between
 * consecutive lines of continuous speech (the default karaoke/keyword styles
 * showed this). Holding until the next line begins removes the flicker — but
 * only across a gap the line grouper did NOT treat as a real pause
 * (≤ GAP_BREAK_SEC); a longer, genuine pause still clears the caption.
 */
export const CAPTION_HOLD_MAX_SEC = 0.8;

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
export function needsSpaceAfter(current: string, next: string | undefined): boolean {
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
 *  - hormozi: 大字爆点——短块、特大加粗、硬阴影、居中偏上,逐词卡拉OK点亮,
 *    拉丁词全大写(海外带货/营销短视频通行的 Hormozi 风格)
 *  - minimal: 动态极简——2026 年 Hormozi 疲劳后的主流:短块卡点上屏、白字
 *    细描边软阴影、不全大写、每块至多 1 个词高亮成品牌色(数字/关键词优先),
 *    克制的 96%→100% 顶入(调研出处:RESEARCH-2026-08-CLIP-QUALITY.md 第二节)
 */
export type CaptionStyle = "karaoke" | "keyword" | "pop" | "hormozi" | "minimal";

export interface CaptionOptions {
  fontName?: string;
  /** Verbatim keywords to emphasize (keyword style). */
  keywords?: string[];
  /** Timeline positions that must start a new line/chunk (jump-cut splices). */
  forcedBreaks?: number[];
  /** Burn the clip title into the top safe zone for the whole clip. */
  titleCard?: { text: string; durationSec: number };
  /**
   * Opening hook: the AI teaser (悬念句) burned big in the upper third for the
   * clip's first seconds — the 黄金3秒 text hook the teaser was written for.
   */
  openingHook?: { text: string; durationSec: number };
  /** 品牌主高亮色 "#RRGGBB"(卡拉OK点亮/关键词强调/钩子文字);缺省火焰橙。 */
  highlightHex?: string;
  /**
   * 双语字幕的译文行(整句级),时间基与 words 一致(clipStartSec 同样平移)。
   * 渲染为主字幕下方的小号 Trans 轨。
   */
  translation?: Array<{ startSec: number; endSec: number; text: string }>;
  /** AIGC 显式标识:左上角小字「AI 生成」全程可见(《标识办法》显式标识)。 */
  aigcBadge?: { durationSec: number };
}

/** Title block sits below platform top overlays (~8% of height) with air. */
function titleMarginV(layout: AssLayout): number {
  return Math.round(layout.playResY * 0.1);
}

/** Opening hook sits in the upper third — below the title, clear of center faces. */
function hookMarginV(layout: AssLayout): number {
  return Math.round(layout.playResY * 0.3);
}

/** 译文轨字号:主字幕的 0.6 倍——双语字幕的主从层级。 */
export function transFontSize(layout: AssLayout): number {
  return Math.round(layout.fontSize * 0.6);
}

/** 译文轨位置:主字幕块正下方(marginV 更小 = 更靠底边),保底不贴边。 */
export function transMarginV(layout: AssLayout): number {
  return Math.max(14, layout.marginV - Math.round(transFontSize(layout) * 1.7));
}

function assHeader(style: CaptionStyle, layout: AssLayout, fontName: string, highlightHex?: string): string[] {
  // 品牌高亮色覆盖默认火焰橙(卡拉OK点亮色 + 开场钩子文字色同源)
  const highlight = (highlightHex && hexToAssColor(highlightHex)) || EMBER_COLOR;
  // karaoke/hormozi: Primary = sung color, Secondary = not-yet-sung; others: plain white
  const primary = style === "karaoke" || style === "hormozi" ? highlight : WHITE_COLOR;
  const fontSize =
    style === "pop" ? Math.round(layout.fontSize * 1.45)
    : style === "hormozi" ? Math.round(layout.fontSize * 1.5)
    : style === "minimal" ? Math.round(layout.fontSize * 1.12)
    : layout.fontSize;
  // hormozi:更厚的描边 + 硬阴影撑住大字;位置抬到 60% 高度线(比底部字幕
  // 醒目、又避开中心人脸)——固定占位,不随品牌位置档位走
  // minimal:细描边 + 一点软阴影——「白字柔和阴影」的动态极简质感
  const outline =
    style === "hormozi" ? layout.outline + 3
    : style === "minimal" ? Math.max(2, layout.outline - 2)
    : layout.outline;
  const shadow = style === "hormozi" ? 3 : style === "minimal" ? 1 : 0;
  const captionMarginV = style === "hormozi" ? Math.round(layout.playResY * 0.4) : layout.marginV;
  const titleSize = Math.round(layout.fontSize * 0.82);
  const hookSize = Math.round(layout.fontSize * 1.25);
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
    `Style: Caption,${fontName},${fontSize},${primary},${WHITE_COLOR},${OUTLINE_COLOR},&H7F000000,-1,0,0,0,100,100,0,0,1,${outline},${shadow},2,${layout.marginH},${layout.marginH},${captionMarginV},1`,
    // title card: opaque-box style (BorderStyle=3) → soft dark plate behind text
    `Style: Title,${fontName},${titleSize},${WHITE_COLOR},${WHITE_COLOR},&H73000000,&H73000000,-1,0,0,0,100,100,0,0,3,12,0,8,${layout.marginH},${layout.marginH},${titleMarginV(layout)},1`,
    // opening hook: ember text on a dark plate, big, upper-third (Alignment 8 + high MarginV)
    `Style: Hook,${fontName},${hookSize},${highlight},${WHITE_COLOR},&H73000000,&H73000000,-1,0,0,0,100,100,0,0,3,14,0,8,${layout.marginH},${layout.marginH},${hookMarginV(layout)},1`,
    // 双语译文轨:小号白字,主字幕块正下方(整句级,不参与卡拉OK)
    `Style: Trans,${fontName},${transFontSize(layout)},${WHITE_COLOR},${WHITE_COLOR},${OUTLINE_COLOR},&H7F000000,-1,0,0,0,100,100,0,0,1,${Math.max(2, layout.outline - 1)},0,2,${layout.marginH},${layout.marginH},${transMarginV(layout)},1`,
    // AIGC 显式标识:左上角半透明小字(Alignment 7;避开右上角默认水印位)
    `Style: Aigc,${fontName},${Math.round(layout.fontSize * 0.42)},&H55FFFFFF,${WHITE_COLOR},&H55000000,&H7F000000,0,0,0,0,100,100,0,0,1,2,0,7,${Math.round(layout.marginH * 0.7)},${layout.marginH},${Math.round(layout.playResY * 0.035)},1`,
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
export function keywordText(line: TranscriptWord[], keywords: string[], highlightHex?: string): string {
  // 品牌高亮色覆盖默认火焰橙(行内 \c 覆写形式)
  const highlightInline = (highlightHex && hexToAssInline(highlightHex)) || EMBER_INLINE;
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
    if (covered[i] && (i === 0 || !covered[i - 1])) parts.push(`{\\c${highlightInline}\\fscx108\\fscy108}`);
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

/** Hormozi punch-in:快速顶入定格(比 pop 的弹跳更硬更利落)。 */
const HORMOZI_INTRO = "{\\fscx82\\fscy82\\t(0,70,\\fscx100\\fscy100)}";

/** Hormozi 短块宽度:约 5 个汉字/2-3 个英文词一屏。 */
const HORMOZI_MAX_UNITS = 10;

/** 动态极简的顶入:96%→100%,80ms——有生气但不抢戏。 */
const MINIMAL_INTRO = "{\\fad(80,0)\\fscx96\\fscy96\\t(0,80,\\fscx100\\fscy100)}";

/** 动态极简短块宽度:与 Hormozi 同档(约 5 汉字),字号小一号所以更透气。 */
const MINIMAL_MAX_UNITS = 10;

/** 数字类 token(含百分号/价格):没有关键词命中时的高亮兜底。 */
const DIGIT_TOKEN_RE = /[0-9][0-9.,]*%?/;

/**
 * 动态极简的块文本:每块至多高亮 1 个词(调研口径「每句最多 1 词,数字/
 * 关键词优先」)。优先级:关键词命中的第一段连续区 > 第一个含数字的 token;
 * 都没有就全白。高亮 = 品牌色 + 8% 放大(与 keyword 风格同款强调语汇)。
 * 纯函数,可单测。
 */
export function minimalText(line: TranscriptWord[], keywords: string[], highlightHex?: string): string {
  const highlightInline = (highlightHex && hexToAssInline(highlightHex)) || EMBER_INLINE;
  // 关键词覆盖判定(与 keywordText 同一套拼接/匹配规则)
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
  // 只保留第一段连续命中,其余降回白字——「每块 ≤1 处高亮」
  let inFirstRun = false;
  let runDone = false;
  for (let i = 0; i < line.length; i++) {
    if (covered[i] && !runDone) {
      inFirstRun = true;
    } else if (inFirstRun) {
      runDone = true;
      inFirstRun = false;
    }
    if (runDone) covered[i] = false;
  }
  // 关键词一处都没有:高亮第一个数字 token(价格/百分比是天然强调点)
  if (!covered.some(Boolean)) {
    const di = line.findIndex((w) => DIGIT_TOKEN_RE.test(w.text));
    if (di >= 0) covered[di] = true;
  }
  const parts: string[] = [];
  for (let i = 0; i < line.length; i++) {
    if (covered[i] && (i === 0 || !covered[i - 1])) parts.push(`{\\c${highlightInline}\\fscx108\\fscy108}`);
    if (!covered[i] && i > 0 && covered[i - 1]) parts.push(`{\\c${WHITE_INLINE}\\fscx100\\fscy100}`);
    parts.push(escapeAssText(line[i].text));
    if (needsSpaceAfter(line[i].text, line[i + 1]?.text)) parts.push(" ");
  }
  return parts.join("");
}

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
  const highlightHex = isValidHex(options.highlightHex) ? options.highlightHex : undefined;
  const events: string[] = [];

  if (options.titleCard && options.titleCard.text.trim()) {
    const tc = options.titleCard;
    events.push(
      `Dialogue: 1,${toAssTime(0)},${toAssTime(tc.durationSec)},Title,,0,0,0,,${wrapTitle(tc.text)}`
    );
  }

  // Opening hook (layer 2, above title & captions): the teaser, faded in/out.
  if (options.openingHook && options.openingHook.text.trim()) {
    const hk = options.openingHook;
    events.push(
      `Dialogue: 2,${toAssTime(0)},${toAssTime(hk.durationSec)},Hook,,0,0,0,,{\\fad(220,300)}${wrapTitle(hk.text)}`
    );
  }

  // AIGC 显式标识:左上角全程小字(layer 3,压在所有轨之上)
  if (options.aigcBadge && options.aigcBadge.durationSec > 0) {
    events.push(`Dialogue: 3,${toAssTime(0)},${toAssTime(options.aigcBadge.durationSec)},Aigc,,0,0,0,,AI 生成`);
  }

  // 双语译文轨:整句级 Dialogue,时间与 words 同基(同样被 clipStartSec 平移);
  // WrapStyle=2 不自动换行,译文行手动折行(阈值按小号字换算)
  if (options.translation) {
    const transUnits = Math.round(layout.maxLineUnits / 0.6);
    for (const line of options.translation) {
      if (!line.text.trim() || line.endSec <= line.startSec) continue;
      const start = Math.max(0, line.startSec - clipStartSec);
      const end = Math.max(start, line.endSec - clipStartSec);
      if (end <= start) continue;
      events.push(`Dialogue: 0,${toAssTime(start)},${toAssTime(end)},Trans,,0,0,0,,${wrapTitle(line.text, transUnits)}`);
    }
  }

  const forcedBreaks = options.forcedBreaks ?? [];
  if (style === "pop" || style === "hormozi" || style === "minimal") {
    const maxUnits =
      style === "pop" ? POP_MAX_UNITS : style === "hormozi" ? HORMOZI_MAX_UNITS : MINIMAL_MAX_UNITS;
    // 动态极简与 keyword 同款:先把关键词连成一个词,断块永远不劈开高亮词
    const chunkWords = style === "minimal" ? mergeKeywordWords(words, options.keywords ?? []) : words;
    const units = groupWordsIntoLines(chunkWords, maxUnits, forcedBreaks);
    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      const start = unit[0].startSec - clipStartSec;
      const lastEnd = unit[unit.length - 1].endSec;
      const next = units[i + 1]?.[0].startSec;
      const end = (next !== undefined ? Math.min(next, lastEnd + CAPTION_HOLD_MAX_SEC) : lastEnd + 0.2) - clipStartSec;
      if (style === "hormozi") {
        // 大字爆点:短块顶入 + 块内逐词卡拉OK点亮;拉丁词全大写(CJK 不受影响)
        const caps = unit.map((w) => ({ ...w, text: w.text.toUpperCase() }));
        events.push(dialogue(start, end, HORMOZI_INTRO + karaokeText(caps)));
      } else if (style === "minimal") {
        // 动态极简:短块轻顶入,块内至多 1 处品牌色高亮(关键词/数字优先)
        events.push(dialogue(start, end, MINIMAL_INTRO + minimalText(unit, options.keywords ?? [], highlightHex)));
      } else {
        const text = unit
          .map((w, j) => escapeAssText(w.text) + (needsSpaceAfter(w.text, unit[j + 1]?.text) ? " " : ""))
          .join("");
        events.push(dialogue(start, end, POP_INTRO + text));
      }
    }
  } else {
    // keyword style: fuse keyword runs first so line breaks can't split them
    const lineWords = style === "keyword" ? mergeKeywordWords(words, options.keywords ?? []) : words;
    const lines = groupWordsIntoLines(lineWords, layout.maxLineUnits, forcedBreaks).filter((l) => l.length > 0);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const start = line[0].startSec - clipStartSec;
      const lastEnd = line[line.length - 1].endSec;
      // Hold the line until the next one begins (anti-flicker), capped so a real
      // pause still clears it; the last line ends with its final word.
      const nextStart = lines[i + 1]?.[0].startSec;
      const end =
        (nextStart !== undefined ? Math.min(nextStart, lastEnd + CAPTION_HOLD_MAX_SEC) : lastEnd) - clipStartSec;
      const text = style === "karaoke" ? karaokeText(line) : keywordText(line, options.keywords ?? [], highlightHex);
      events.push(dialogue(start, end, text));
    }
  }

  return [...assHeader(style, layout, fontName, highlightHex), ...events, ""].join("\n");
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
