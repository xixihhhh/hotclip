/**
 * 高潮前置(cold-open):把切片内最炸的钩子句剪成迷你片拼到开头,再接完整
 * 正片(播到原位置时原样重复——综艺/切片圈通行手法)。前 3 秒抓不住人就
 * 划走,这是短视频完播率的命门;商业工具把 AI Hook 锁在付费档。
 * 本模块只做纯决策(钩子句定位+取舍),拼接由导出层用 concatClips 完成。
 *
 * 两种迷你片:
 *  - planColdOpen:钩子**句**前置(1-4s,靠转写反查,信息型钩子)
 *  - planFlashForward:爆点**画面**闪现(0.3-1s,靠响度峰值事件定位,视觉型
 *    钩子)——2026 调研:全网仅 0.04% 切片有 visual hook,flash-forward
 *    (闪现结局再切回开头)是被人类工艺与开源实现互证的空白手法。
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

/** 闪现片段:峰值前带一点铺垫帧、峰值后留一点余韵。 */
export const FLASH_LEAD_SEC = 0.2;
export const FLASH_TAIL_SEC = 0.5;
/** 短于此的闪现观众根本看不清(调研口径 0.3-1s,取下限做门槛)。 */
export const FLASH_MIN_SEC = 0.3;
/** 爆点在成片输出时间上离开头太近就不闪——马上就要看到了,闪现即剧透。 */
export const FLASH_SKIP_NEAR_START_SEC = 6;

/**
 * 决定爆点闪现(flash-forward)片段:从峰值事件(按强度从高到低,调用方已
 * 过滤掉离输出开头太近的)里挑第一个能在保留区间内装下完整闪现窗的。
 * 传保留区间而不是切片首尾:跳剪/拼接后被剪掉的内容不该出现在闪现里
 * (拼接片的段间空隙也天然被排除——保留段不会跨段)。挑不出返回 null,
 * 与 planColdOpen 同一语义:锦上添花,宁可不做不可做错。纯函数。
 */
export function planFlashForward(
  peakAtSec: number[],
  keptSegments: Array<{ startSec: number; endSec: number }>
): ColdOpenPlan | null {
  for (const at of peakAtSec) {
    const seg = keptSegments.find((s) => at >= s.startSec && at < s.endSec);
    if (!seg) continue;
    const startSec = Math.max(seg.startSec, at - FLASH_LEAD_SEC);
    const endSec = Math.min(seg.endSec, at + FLASH_TAIL_SEC);
    // 1e-6 容差:边界夹取的浮点误差不该把恰好达标的窗判掉
    if (endSec - startSec >= FLASH_MIN_SEC - 1e-6) return { startSec, endSec };
  }
  return null;
}
