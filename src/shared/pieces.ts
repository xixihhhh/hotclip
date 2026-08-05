/**
 * 多片段拼接:一条切片由若干不连续的源片区间按时间顺序拼成。
 *
 * 为什么需要:真正的爆款切片常常不是一段连续录像——「前后打脸」必须把相隔
 * 十几分钟的两处话摆在一起才成立;带货的「三段式」也是从直播不同位置各取一
 * 段。检测侧只负责给出片段清单,拼接本身复用既有的跳剪机器:段间空隙当成
 * 强制剪除区间喂给 computeJumpCut,于是字幕/译文/EDL/封面/质检全都自动对齐,
 * 不需要第二套时间轴逻辑。
 *
 * 纯函数模块,不碰 ffmpeg——放 shared 是因为渲染进程(审阅台/候选卡)也要按
 * 同一套规则算成片时长、画出段落条,两边算法必须是同一份代码。
 */
import type { TranscriptWord, ClipPiece } from "./api-types";

export type { ClipPiece };

/** 单段最短时长:比这还短的拼进来只是碎片,观众只会觉得跳。 */
export const MIN_PIECE_SEC = 2;
/** 最多拼几段:再多就不是「对照」而是拼贴,断章取义风险陡增。 */
export const MAX_PIECES = 4;
/** 两段间隔小于此值视为同一段(中间那点空隙不值得剪)。 */
export const PIECE_MERGE_GAP_SEC = 1.2;
/** 段尾留白 / 段首留白:拼接处不贴着词切,否则听感是硬生生掐断。 */
export const PIECE_PAD_AFTER_SEC = 0.25;
export const PIECE_PAD_BEFORE_SEC = 0.15;
/** 拼接文本的省略标记——审阅台和评审 prompt 都靠它看出「这里跳了」。 */
export const PIECE_JOINER = " …… ";

/**
 * 规整片段清单:按时间排序 → 合并重叠/紧邻 → 丢掉过短碎片 → 超额时保留最长
 * 的几段(仍按时间排回)。返回长度 <2 表示这条其实是单段,调用方按单段处理。
 */
export function normalizePieces(raw: ClipPiece[]): ClipPiece[] {
  const valid = raw
    .filter((p) => Number.isFinite(p.startSec) && Number.isFinite(p.endSec) && p.endSec > p.startSec)
    .map((p) => ({ startSec: p.startSec, endSec: p.endSec }))
    .sort((a, b) => a.startSec - b.startSec);
  if (valid.length === 0) return [];

  const merged: ClipPiece[] = [valid[0]];
  for (const p of valid.slice(1)) {
    const last = merged[merged.length - 1];
    if (p.startSec - last.endSec < PIECE_MERGE_GAP_SEC) {
      last.endSec = Math.max(last.endSec, p.endSec);
    } else {
      merged.push(p);
    }
  }

  const long = merged.filter((p) => p.endSec - p.startSec >= MIN_PIECE_SEC);
  // 全都过短时别把这条整个抹掉——留最长的一段,让上游退化成单段
  const kept = long.length > 0 ? long : [merged.reduce((a, b) => (b.endSec - b.startSec > a.endSec - a.startSec ? b : a))];
  if (kept.length <= MAX_PIECES) return kept;
  return [...kept]
    .sort((a, b) => b.endSec - b.startSec - (a.endSec - a.startSec))
    .slice(0, MAX_PIECES)
    .sort((a, b) => a.startSec - b.startSec);
}

/** 拼接后的成片时长(各段时长之和,不含被跳过的空隙)。 */
export function piecesDurationSec(pieces: ClipPiece[]): number {
  return pieces.reduce((acc, p) => acc + (p.endSec - p.startSec), 0);
}

/** 一条切片的实际成片时长:多段取各段之和,单段取区间长度。 */
export function clipDurationSec(clip: { startSec: number; endSec: number; pieces?: ClipPiece[] }): number {
  const p = clip.pieces;
  return p && p.length > 1 ? piecesDurationSec(p) : clip.endSec - clip.startSec;
}

/** 多段拼接才算数:0/1 段就是普通切片。 */
export function isStitched(pieces: ClipPiece[] | undefined): boolean {
  return (pieces?.length ?? 0) > 1;
}

/**
 * 段与段之间要剪掉的区间(喂给 computeJumpCut 的 forceCutSpans)。
 * 两端各留一点余白,拼接处才不会贴着词硬切。
 */
export function pieceCutSpans(pieces: ClipPiece[]): ClipPiece[] {
  const out: ClipPiece[] = [];
  for (let i = 1; i < pieces.length; i++) {
    const startSec = pieces[i - 1].endSec + PIECE_PAD_AFTER_SEC;
    const endSec = pieces[i].startSec - PIECE_PAD_BEFORE_SEC;
    if (endSec > startSec) out.push({ startSec, endSec });
  }
  return out;
}

/** 区间是否整个落在某一段内——高潮前置/取景之类只能在单段内做的守卫。 */
export function withinOnePiece(pieces: ClipPiece[], startSec: number, endSec: number): boolean {
  return pieces.some((p) => startSec >= p.startSec - 1e-3 && endSec <= p.endSec + 1e-3);
}

/** 与 core/gaps 的 JumpCutPlan 同构(shared 不依赖 core,按结构声明)。 */
export interface PiecePlan {
  segments: ClipPiece[];
  words: TranscriptWord[];
  breaks: number[];
  removedSec: number;
  durationSec: number;
}

/**
 * 没有词表时(既不烧字幕也不跳剪)的成片计划:段清单本身就是保留区间。
 * 形状与 computeJumpCut 的产物一致,下游(cutJumpClip/封面/EDL/质检)无感。
 */
export function planFromPieces(pieces: ClipPiece[]): PiecePlan {
  const durationSec = piecesDurationSec(pieces);
  const breaks: number[] = [];
  let out = 0;
  for (let i = 0; i < pieces.length; i++) {
    if (i > 0) breaks.push(out);
    out += pieces[i].endSec - pieces[i].startSec;
  }
  const span = pieces.length > 0 ? pieces[pieces.length - 1].endSec - pieces[0].startSec : 0;
  return { segments: pieces.map((p) => ({ ...p })), words: [], breaks, removedSec: span - durationSec, durationSec };
}

/** 跨段合并词表:只保留落在某一段内的词(段间空隙的内容不进成片)。 */
export function wordsInPieces<T extends { startSec: number; endSec: number }>(
  words: T[],
  pieces: ClipPiece[]
): T[] {
  return words.filter((w) => {
    const mid = (w.startSec + w.endSec) / 2;
    return pieces.some((p) => mid >= p.startSec && mid <= p.endSec);
  });
}
