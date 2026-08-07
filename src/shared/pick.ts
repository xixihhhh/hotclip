/**
 * 文稿选段(文字剪视频):把勾选的句子集合成拼接片清单。
 * 只按「文稿相邻」合并——中间被用户跳过的句子绝不并进来(哪怕时间间隔很短,
 * 跳过就是用户的明确决定);非相邻的选中组各自成段,顺序即时间序。
 * 纯函数,渲染进程(选段弹窗)与测试共用。
 */
import type { TranscriptSegment, ClipPiece } from "./api-types";

/** 手动拼接段数上限:再多就不是切片而是剪辑工程了,审阅台也看不过来。 */
export const MANUAL_MAX_PIECES = 8;
/** 手动成片时长范围(与 boundary.ts 手动微调的 MIN/MAX 同口径)。 */
export const MANUAL_MIN_SEC = 3;
export const MANUAL_MAX_SEC = 120;

/** 按文稿顺序把选中句子并成段:相邻选中延长当前段,断开另起一段。 */
export function selectionToPieces(
  segments: TranscriptSegment[],
  selected: ReadonlySet<number>
): ClipPiece[] {
  const out: ClipPiece[] = [];
  let open: ClipPiece | null = null;
  for (const seg of segments) {
    if (selected.has(seg.id)) {
      if (open) {
        open.endSec = seg.endSec;
      } else {
        open = { startSec: seg.startSec, endSec: seg.endSec };
        out.push(open);
      }
    } else {
      open = null;
    }
  }
  return out;
}

/** 选段是否能成片;不能时给出原因(禁用「加入候选」按钮并解释为什么)。 */
export type PickVerdict = "ok" | "empty" | "tooShort" | "tooLong" | "tooMany";

export function pickVerdict(pieces: ClipPiece[], durationSec: number): PickVerdict {
  if (pieces.length === 0) return "empty";
  if (pieces.length > MANUAL_MAX_PIECES) return "tooMany";
  if (durationSec < MANUAL_MIN_SEC) return "tooShort";
  if (durationSec > MANUAL_MAX_SEC) return "tooLong";
  return "ok";
}
