/**
 * Payload builder for web-rendered caption overlays: turns timed words into
 * the JSON contract the HTML templates consume. Line breaking and keyword
 * fusion reuse the proven ASS pipeline logic, so web captions and libass
 * captions break identically. Pure — the Electron renderer lives in main/.
 */
import { groupWordsIntoLines, mergeKeywordWords, CAPTION_HOLD_MAX_SEC, type AssLayout } from "../subtitle";
import { isValidHex, lightenHex, DEFAULT_HIGHLIGHT_HEX } from "../brand";
import type { TranscriptWord } from "../../shared/api-types";
import type { ColorRenderPlan } from "../color";

/** Caption styles rendered by the web overlay engine (name = template file). */
export type WebCaptionStyle = "bubble";

export function isWebCaptionStyle(style: string | undefined): style is WebCaptionStyle {
  return style === "bubble";
}

/**
 * Overlay renderer contract. The implementation lives in the Electron main
 * process (it needs a BrowserWindow); core code takes it via injection so the
 * export pipeline stays free of electron imports.
 */
export type OverlayRenderFn = (
  basePath: string,
  outPath: string,
  payload: OverlayPayload,
  durationSec: number,
  template: string,
  options?: OverlayOutputOptions
) => Promise<void>;

/** Output-only render metadata needed after the base clip is already assembled. */
export interface OverlayOutputOptions {
  /** Restate BT.709 on overlay re-encodes of a tone-mapped base clip. */
  color?: ColorRenderPlan;
  /** Global stream indices selected from the already-rendered base clip. */
  videoStreamIndex?: number;
  audioStreamIndex?: number;
}

export interface OverlayWord {
  text: string;
  startMs: number;
  endMs: number;
  /** True when the word is one of the clip's emphasis keywords. */
  keyword: boolean;
  /** Diarization speaker id (0-based); absent when not diarized. */
  speaker?: number;
}

export interface OverlayLine {
  startMs: number;
  endMs: number;
  words: OverlayWord[];
}

export interface OverlayPayload {
  width: number;
  height: number;
  /** Caption line center, as a fraction of frame height from the top. */
  baselineFrac: number;
  /** Base font size in CSS pixels (frame pixels — the window is 1:1). */
  fontSize: number;
  /** 关键词渐变的起始色(品牌高亮色);缺省火焰橙。 */
  highlightColor: string;
  /** 渐变第二停靠色(高亮色向白提亮),模板直接用。 */
  highlightColor2: string;
  lines: OverlayLine[];
}

/** Lines end when the next one starts; the last line gets a short linger. */
const LINE_LINGER_MS = 350;

export function buildOverlayPayload(
  words: TranscriptWord[],
  layout: AssLayout,
  options: { keywords?: string[]; forcedBreaks?: number[]; highlightHex?: string } = {}
): OverlayPayload {
  const fused = mergeKeywordWords(words, options.keywords ?? []);
  const keywordSet = new Set(
    (options.keywords ?? []).map((k) => k.toLowerCase()).filter(Boolean)
  );
  const grouped = groupWordsIntoLines(fused, layout.maxLineUnits, options.forcedBreaks).filter(
    (l) => l.length > 0
  );

  const lines: OverlayLine[] = grouped.map((lineWords, i) => {
    const next = grouped[i + 1];
    const start = lineWords[0].startSec;
    const lastEnd = lineWords[lineWords.length - 1].endSec;
    // Hold each line until the next begins (anti-flicker), capped so a real
    // pause still clears it; the last line gets a short linger.
    const end = next
      ? Math.min(next[0].startSec, lastEnd + CAPTION_HOLD_MAX_SEC)
      : lastEnd + LINE_LINGER_MS / 1000;
    return {
      startMs: Math.round(start * 1000),
      endMs: Math.round(Math.max(end, lastEnd) * 1000),
      words: lineWords.map((w) => ({
        text: w.text,
        startMs: Math.round(w.startSec * 1000),
        endMs: Math.round(w.endSec * 1000),
        keyword: keywordSet.has(w.text.toLowerCase()),
        speaker: w.speaker,
      })),
    };
  });

  // marginV is measured from the frame bottom to the caption baseline
  const baselineFrac = (layout.playResY - layout.marginV) / layout.playResY;
  const highlightColor = isValidHex(options.highlightHex) ? options.highlightHex : DEFAULT_HIGHLIGHT_HEX;
  return {
    width: layout.playResX,
    height: layout.playResY,
    baselineFrac,
    fontSize: layout.fontSize,
    highlightColor,
    highlightColor2: lightenHex(highlightColor, 0.55),
    lines,
  };
}
