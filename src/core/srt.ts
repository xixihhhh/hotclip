/**
 * SRT 字幕文件导出:每条切片旁落同名 .srt——平台原生字幕上传(B站/YouTube
 * 都吃)、剪辑器二次精修、无障碍全靠它;烧录字幕是"看的",SRT 是"用的"。
 *
 * 词与译文都来自导出管线(跳剪重映射/口水词剔除已生效),分行沿用烧录字幕
 * 的同一套断行规则,保证 .srt 与画面里的字幕逐行一致。纯字符串构建,零依赖。
 */
import type { TranscriptWord } from "../shared/api-types";
import { groupWordsIntoLines, needsSpaceAfter, CAPTION_HOLD_MAX_SEC, planReadableCaptions, type CaptionReadabilityOptions } from "./subtitle";
import type { TranslationLine } from "./translate";

/** SRT 行宽(视觉单位:CJK=2/latin=1)——比竖屏字幕宽,接近通用播放器习惯。 */
export const SRT_MAX_LINE_UNITS = 36;

export interface SrtLine {
  startSec: number;
  endSec: number;
  text: string;
  /** 双语时的译文(渲染为第二行)。 */
  secondary?: string;
}

/** SRT 时间格式 HH:MM:SS,mmm(负数夹为 0)。 */
export function formatSrtTime(sec: number): string {
  const total = Math.max(0, Math.round(sec * 1000));
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60_000) % 60;
  const h = Math.floor(total / 3_600_000);
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
}

/**
 * 词 → SRT 行(时间为切片相对时间;words 传入前先做好 clipStartSec 平移
 * 与跳剪重映射,与烧录字幕同一时间基)。译文按时间重叠附为第二行。
 */
export function srtLinesFromWords(
  words: TranscriptWord[],
  forcedBreaks: number[] = [],
  translation: TranslationLine[] = [],
  options: CaptionReadabilityOptions = {}
): SrtLine[] {
  const planned = options.readability ? planReadableCaptions(words, SRT_MAX_LINE_UNITS, forcedBreaks, options.endSec) : undefined;
  const lines = planned ? planned.map((line) => line.words) : groupWordsIntoLines(words, SRT_MAX_LINE_UNITS, forcedBreaks).filter((l) => l.length > 0);
  const out: SrtLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const startSec = line[0].startSec;
    const lastEnd = line[line.length - 1].endSec;
    const nextStart = lines[i + 1]?.[0].startSec;
    const endSec = planned?.[i].endSec ?? (nextStart !== undefined ? Math.min(nextStart, lastEnd + CAPTION_HOLD_MAX_SEC) : lastEnd);
    const text = line
      .map((w, j) => w.text + (needsSpaceAfter(w.text, line[j + 1]?.text) ? " " : ""))
      .join("")
      .trim();
    if (!text || endSec <= startSec) continue;
    // 译文:取与本行时间重叠最长的一条
    let secondary: string | undefined;
    let bestOverlap = 0;
    for (const t of translation) {
      const ov = Math.min(endSec, t.endSec) - Math.max(startSec, t.startSec);
      if (ov > bestOverlap) {
        bestOverlap = ov;
        secondary = t.text;
      }
    }
    out.push({ startSec, endSec, text, ...(secondary ? { secondary } : {}) });
  }
  return out;
}

/** 组装完整 SRT 文档。 */
export function buildSrt(lines: SrtLine[]): string {
  return lines
    .map((l, i) => {
      const body = l.secondary ? `${l.text}\n${l.secondary}` : l.text;
      return `${i + 1}\n${formatSrtTime(l.startSec)} --> ${formatSrtTime(l.endSec)}\n${body}\n`;
    })
    .join("\n");
}
