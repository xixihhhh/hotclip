/**
 * Payload builder for web-rendered caption overlays: turns timed words into
 * the JSON contract the HTML templates consume. Line breaking and keyword
 * fusion reuse the proven ASS pipeline logic, so web captions and libass
 * captions break identically. Pure — the Electron renderer lives in main/.
 */
import { groupWordsIntoLines, mergeKeywordWords, type AssLayout } from "../subtitle";
import type { TranscriptWord } from "../../shared/api-types";

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
  template: string
) => Promise<void>;

export interface OverlayWord {
  text: string;
  startMs: number;
  endMs: number;
  /** True when the word is one of the clip's emphasis keywords. */
  keyword: boolean;
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
  lines: OverlayLine[];
}

/** Lines end when the next one starts; the last line gets a short linger. */
const LINE_LINGER_MS = 350;

export function buildOverlayPayload(
  words: TranscriptWord[],
  layout: AssLayout,
  options: { keywords?: string[]; forcedBreaks?: number[] } = {}
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
    const end = next ? Math.min(next[0].startSec, lastEnd + LINE_LINGER_MS / 1000) : lastEnd + LINE_LINGER_MS / 1000;
    return {
      startMs: Math.round(start * 1000),
      endMs: Math.round(Math.max(end, lastEnd) * 1000),
      words: lineWords.map((w) => ({
        text: w.text,
        startMs: Math.round(w.startSec * 1000),
        endMs: Math.round(w.endSec * 1000),
        keyword: keywordSet.has(w.text.toLowerCase()),
      })),
    };
  });

  // marginV is measured from the frame bottom to the caption baseline
  const baselineFrac = (layout.playResY - layout.marginV) / layout.playResY;
  return {
    width: layout.playResX,
    height: layout.playResY,
    baselineFrac,
    fontSize: layout.fontSize,
    lines,
  };
}
