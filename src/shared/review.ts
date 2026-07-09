/**
 * 候选切片审阅台的纯逻辑:上下文窗口、拖拽吸附字词边界、拖动范围钳制、
 * 切片文本重算。与平台无关,渲染层交互和单元测试共用。
 */
import type { Transcript, TranscriptWord } from "./api-types";

const EPS = 1e-3;
/** 手动微调允许的时长范围(与 boundary.ts 的守卫一致)。 */
export const REVIEW_MIN_SEC = 3;
export const REVIEW_MAX_SEC = 120;

export interface ReviewWindow {
  winStartSec: number;
  winEndSec: number;
}

/** 审阅时间轴的上下文窗口:切片两侧各留一段余量,便于向外扩切点。 */
export function contextWindow(startSec: number, endSec: number, durationSec: number): ReviewWindow {
  const pad = Math.min(20, Math.max(6, (endSec - startSec) * 0.4));
  return {
    winStartSec: Math.max(0, startSec - pad),
    winEndSec: Math.max(endSec, Math.min(durationSec, endSec + pad)),
  };
}

/** 窗口内(含跨边界)的全部词,按时间排序——时间轴吸附的候选点。 */
export function wordsInWindow(transcript: Transcript, winStartSec: number, winEndSec: number): TranscriptWord[] {
  return transcript.segments
    .filter((s) => s.endSec > winStartSec && s.startSec < winEndSec)
    .flatMap((s) => s.words)
    .filter((w) => w.endSec > winStartSec && w.startSec < winEndSec)
    .sort((a, b) => a.startSec - b.startSec);
}

/**
 * 拖拽吸附:起点吸到最近的词首、终点吸到最近的词尾(容差内),
 * 容差外原样返回——拖到没词的地方(空镜/静音)也允许自由落点。
 */
export function snapToWordEdge(
  sec: number,
  words: readonly Pick<TranscriptWord, "startSec" | "endSec">[],
  edge: "start" | "end",
  toleranceSec: number
): number {
  let best = sec;
  let bestDist = toleranceSec + EPS;
  for (const w of words) {
    const cand = edge === "start" ? w.startSec : w.endSec;
    const d = Math.abs(cand - sec);
    if (d < bestDist) {
      bestDist = d;
      best = cand;
    }
  }
  return best;
}

/**
 * 拖动一侧手柄的钳制:不越过另一侧(保住最短时长)、不超最长时长、
 * 不出窗口。"不越过另一侧"是硬规则,窗口边界在冲突时让位。
 */
export function clampDrag(
  edge: "start" | "end",
  sec: number,
  oppositeSec: number,
  win: ReviewWindow
): number {
  if (edge === "start") {
    const hi = oppositeSec - REVIEW_MIN_SEC;
    const lo = Math.min(hi, Math.max(win.winStartSec, oppositeSec - REVIEW_MAX_SEC));
    return Math.min(hi, Math.max(lo, sec));
  }
  const lo = oppositeSec + REVIEW_MIN_SEC;
  const hi = Math.max(lo, Math.min(win.winEndSec, oppositeSec + REVIEW_MAX_SEC));
  return Math.max(lo, Math.min(hi, sec));
}

/** 重算当前范围覆盖的逐句稿文本(与 boundary.ts 的重叠规则一致)。 */
export function clipText(transcript: Transcript, startSec: number, endSec: number): string {
  return transcript.segments
    .filter((s) => s.endSec > startSec + EPS && s.startSec < endSec - EPS)
    .map((s) => s.text)
    .join(" ");
}
