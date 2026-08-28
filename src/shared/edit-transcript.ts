/**
 * 逐句稿纠错:ASR 错字会一路烧进字幕/翻译/发布文案,在转写页当场改掉
 * 最省事。改完句子文本后,该句的词级时间轴按"字符视觉宽度占比"重建
 * (CJK 逐字、英文按词)——卡拉OK扫色在该句内会略均匀化,但字是对的;
 * 错字与略糙的扫色之间,永远选后者。纯函数,可完整单测。
 */
import type { Transcript, TranscriptWord } from "./api-types";

const CJK_RE = /[一-鿿぀-ヿ가-힯]/;
const WORD_CHAR_RE = /[A-Za-z0-9''-]/;

/** 把编辑后的句子切成卡拉OK词单元:CJK 单字、latin 词、标点附着前词。 */
export function tokenizeForWords(text: string): string[] {
  const tokens: string[] = [];
  let latin = "";
  const flushLatin = (): void => {
    if (latin) {
      tokens.push(latin);
      latin = "";
    }
  };
  for (const ch of Array.from(text)) {
    if (WORD_CHAR_RE.test(ch)) {
      latin += ch;
      continue;
    }
    flushLatin();
    if (/\s/.test(ch)) continue;
    if (CJK_RE.test(ch)) {
      tokens.push(ch);
    } else if (tokens.length > 0) {
      tokens[tokens.length - 1] += ch; // 标点附着前词(与 ASR 词形一致)
    } else {
      tokens.push(ch);
    }
  }
  flushLatin();
  return tokens;
}

/** 视觉宽度:CJK=2,latin/数字=1,其余(标点)=0.5——时间分配的权重。 */
function tokenWeight(token: string): number {
  let w = 0;
  for (const ch of Array.from(token)) {
    w += CJK_RE.test(ch) ? 2 : WORD_CHAR_RE.test(ch) ? 1 : 0.5;
  }
  return Math.max(0.5, w);
}

/** 按权重把 [startSec, endSec] 均匀分给各词(首尾对齐,无缝无重叠)。 */
export function rebuildWords(text: string, startSec: number, endSec: number): TranscriptWord[] {
  const tokens = tokenizeForWords(text);
  const dur = Math.max(0, endSec - startSec);
  if (tokens.length === 0 || dur <= 0) return [];
  const weights = tokens.map(tokenWeight);
  const total = weights.reduce((a, b) => a + b, 0);
  const out: TranscriptWord[] = [];
  let t = startSec;
  for (let i = 0; i < tokens.length; i++) {
    const end = i === tokens.length - 1 ? endSec : t + (dur * weights[i]) / total;
    out.push({ text: tokens[i], startSec: t, endSec: end, timingSource: "edited" });
    t = end;
  }
  return out;
}

/**
 * 改一句的文本:替换 text 并重建该句 words,其余句原样。空文本视为
 * 误操作,返回原 transcript 不变。
 */
export function editSegmentText(transcript: Transcript, segmentId: number, newText: string): Transcript {
  const text = newText.trim();
  if (!text) return transcript;
  return {
    ...transcript,
    segments: transcript.segments.map((seg) =>
      seg.id === segmentId
        ? { ...seg, text, words: rebuildWords(text, seg.startSec, seg.endSec) }
        : seg
    ),
  };
}
