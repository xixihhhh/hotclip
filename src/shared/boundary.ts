/**
 * Sentence-step boundary adjustment for highlight clips: extend/shrink either
 * edge by whole transcript sentences (word-accurate boundaries come free —
 * segments are built from word timestamps). Pure & platform-neutral so both
 * the renderer (interactive tweaking) and core can use it.
 */
import type { Transcript, TranscriptSegment, ClipPiece } from "./api-types";
import { mergePieces, PIECE_JOINER } from "./pieces";

const EPS = 1e-3;
/** Manual tweaking is allowed a wider range than auto-detection. */
const MIN_SEC = 3;
const MAX_SEC = 120;

function overlapping(transcript: Transcript, startSec: number, endSec: number): TranscriptSegment[] {
  return transcript.segments.filter((s) => s.endSec > startSec + EPS && s.startSec < endSec - EPS);
}

export interface AdjustedBoundary {
  startSec: number;
  endSec: number;
  text: string;
}

/**
 * Move one clip edge by one sentence. `dir` follows the timeline:
 *  - start edge: -1 pulls the previous sentence in, +1 drops the first one
 *  - end edge:   +1 pulls the next sentence in,     -1 drops the last one
 * Returns null when the move is impossible (no neighbour, would collapse,
 * or leaves the duration outside sane bounds).
 */
export function adjustClipBoundary(
  transcript: Transcript,
  clip: { startSec: number; endSec: number },
  edge: "start" | "end",
  dir: 1 | -1
): AdjustedBoundary | null {
  const segs = transcript.segments;
  const inside = overlapping(transcript, clip.startSec, clip.endSec);
  if (inside.length === 0) return null;

  let startSec = clip.startSec;
  let endSec = clip.endSec;

  if (edge === "start") {
    const firstIdx = segs.findIndex((s) => s.id === inside[0].id);
    if (dir === -1) {
      if (firstIdx <= 0) return null;
      startSec = segs[firstIdx - 1].startSec;
    } else {
      if (inside.length < 2) return null;
      startSec = inside[1].startSec;
    }
  } else {
    const lastIdx = segs.findIndex((s) => s.id === inside[inside.length - 1].id);
    if (dir === 1) {
      if (lastIdx < 0 || lastIdx + 1 >= segs.length) return null;
      endSec = segs[lastIdx + 1].endSec;
    } else {
      if (inside.length < 2) return null;
      endSec = inside[inside.length - 2].endSec;
    }
  }

  const dur = endSec - startSec;
  if (dur < MIN_SEC || dur > MAX_SEC) return null;
  const text = overlapping(transcript, startSec, endSec)
    .map((s) => s.text)
    .join(" ");
  return { startSec, endSec, text };
}

export interface AdjustedCandidate extends AdjustedBoundary {
  /** 拼接片调整后的段清单;单段切片不带此字段。 */
  pieces?: ClipPiece[];
}

/**
 * 候选级的切点微调。拼接片只动**第一段的起点**和**最后一段的终点**——中间
 * 那几段是 AI 挑来做对照的,用户按左右箭头时不该被悄悄挪走;调到两段并成
 * 一段(拼接不复存在)时直接拒绝这次调整,让用户自己去审阅台改。
 */
export function adjustCandidateBoundary(
  transcript: Transcript,
  clip: { startSec: number; endSec: number; pieces?: ClipPiece[] },
  edge: "start" | "end",
  dir: 1 | -1
): AdjustedCandidate | null {
  const pieces = clip.pieces;
  if (!pieces || pieces.length < 2) return adjustClipBoundary(transcript, clip, edge, dir);

  const idx = edge === "start" ? 0 : pieces.length - 1;
  const moved = adjustClipBoundary(transcript, pieces[idx], edge, dir);
  if (!moved) return null;
  // mergePieces 而非 normalizePieces:这里只动了首/尾段的边,段数不该被
  // 「最多 4 段/最短 2 秒」的检测侧规整悄悄改掉(手动选段可以超过 4 段)
  const next = mergePieces(
    pieces.map((p, i) => (i === idx ? { startSec: moved.startSec, endSec: moved.endSec } : p))
  );
  if (next.length < 2) return null;
  return {
    startSec: next[0].startSec,
    endSec: next[next.length - 1].endSec,
    pieces: next,
    text: piecesText(transcript, next),
  };
}

/** 拼接片的展示文本:各段原文用省略标记连起来,一眼看得出中间跳了。 */
export function piecesText(transcript: Transcript, pieces: ClipPiece[]): string {
  return pieces
    .map((p) => overlapping(transcript, p.startSec, p.endSec).map((s) => s.text).join(" "))
    .join(PIECE_JOINER);
}
