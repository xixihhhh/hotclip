/**
 * 高潮前置(cold-open):把切片内最炸的钩子句剪成迷你片拼到开头,再接完整
 * 正片(播到原位置时原样重复——综艺/切片圈通行手法)。前 3 秒抓不住人就
 * 划走,这是短视频完播率的命门;商业工具把 AI Hook 锁在付费档。
 * 本模块只做纯决策(钩子句定位+取舍),拼接由导出层用 concatClips 完成。
 */
import type { TranscriptWord } from "../shared/api-types";
import { buildTokenIndex, matchQuote } from "./highlight/match";

export interface ColdOpenPlan {
  startSec: number;
  endSec: number;
}

/** 迷你片太短观众接收不到信息(通行下限约 1 秒/半句话)。 */
export const COLD_OPEN_MIN_SEC = 1;
/** 超过 3-4 秒还没进正片就开始掉人(OpusClip 方法论:2-2.5 秒内交付完毕)。 */
export const COLD_OPEN_MAX_SEC = 4;
/** 爆点距开头太近时再前置一遍显得机械重复,通行建议 <10-15 秒就跳过。 */
export const COLD_OPEN_SKIP_NEAR_START_SEC = 10;

/**
 * 决定这条切片的 cold-open 片段:在切片词流里反查钩子句(与选段同一套
 * 引用对齐),不满足任一条件返回 null(前置是锦上添花,宁可不做不可做错):
 * - 钩子句定位失败(LLM 引用偶尔与转写有出入)
 * - 钩子句离切片开头太近(已经是开场,重复没意义)
 * - 片段过短;过长则截到 MAX(按词边界收口)
 */
export function planColdOpen(
  clipWords: TranscriptWord[],
  hookText: string,
  clipStartSec: number
): ColdOpenPlan | null {
  const hook = (hookText ?? "").trim();
  if (!hook || clipWords.length === 0) return null;
  const m = matchQuote(buildTokenIndex(clipWords), hook, hook);
  if (!m) return null;
  if (m.startSec - clipStartSec < COLD_OPEN_SKIP_NEAR_START_SEC) return null;

  let endSec = m.endSec;
  if (endSec - m.startSec > COLD_OPEN_MAX_SEC) {
    // 从句首起截 MAX 秒,收口到不超界的最后一个词尾(卡拉OK不切半个词)
    const cap = m.startSec + COLD_OPEN_MAX_SEC;
    let snapped = m.startSec;
    for (const w of clipWords) {
      if (w.startSec >= m.startSec - 1e-3 && w.endSec <= cap + 1e-3) snapped = Math.max(snapped, w.endSec);
    }
    endSec = snapped;
  }
  if (endSec - m.startSec < COLD_OPEN_MIN_SEC) return null;
  return { startSec: m.startSec, endSec };
}
