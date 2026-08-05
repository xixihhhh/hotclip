/**
 * 智能封面选帧:封面从"固定开头 0.8 秒"升级为"切片内响度最高的一帧"——
 * 响度峰值处通常是笑点/喊叫/情绪最高点,正是该当门面的那一帧;固定时刻
 * 常拍到过渡帧或闭眼帧。带惊讶/激动表情的封面点击率高 20-30%(行业实测),
 * 响度是它的免费代理信号。
 *
 * 输入是源时间的峰值轨与切片保留区间(跳剪时多段),输出"成片输出时间"
 * 上的封面时刻。纯函数,无 ffmpeg 依赖。
 */
import type { PeakTrack } from "./audio-peaks";
import type { KeptSegment } from "./gaps";

/** 避开成片首尾的秒数(转场/淡入淡出常在这)。 */
const EDGE_GUARD_SEC = 0.4;

/** 旧行为:hook 落点后不久的固定帧(无峰值数据时的回退)。 */
export function fallbackCoverTime(durationSec: number): number {
  return Math.min(0.8, Math.max(0, durationSec - 0.1));
}

/** 不同名次的峰之间的最小间隔:太近就是同一个高潮,换帧没有差异化意义。 */
const PEAK_MIN_GAP_SEC = 1.5;

/**
 * 在保留区间内找响度第 rank+1 高的时刻(rank 0 = 最高,与历史行为一致),
 * 并映射到输出时间轴。一片多版的变体封面靠 rank 抓不同的情绪峰。
 * 峰不够多时用最后一个可用的;找不到可靠峰(无轨/全静音/时长太短)回退固定帧。
 */
export function pickCoverTime(
  peaks: PeakTrack | undefined,
  ranges: KeptSegment[],
  durationSec: number,
  rank = 0
): number {
  const fallback = fallbackCoverTime(durationSec);
  if (!peaks || peaks.values.length === 0 || durationSec <= EDGE_GUARD_SEC * 2 || ranges.length === 0) {
    return fallback;
  }
  // 收集所有落在保留区间且避开首尾的采样点(输出时间, 峰值)
  const candidates: Array<{ out: number; peak: number }> = [];
  let outOffset = 0;
  for (const seg of ranges) {
    for (let i = 0; i < peaks.values.length; i++) {
      const t = peaks.startSec + i * peaks.hopSec; // 源时间
      if (t < seg.startSec || t >= seg.endSec) continue;
      const out = outOffset + (t - seg.startSec); // 输出时间
      if (out < EDGE_GUARD_SEC || out > durationSec - EDGE_GUARD_SEC) continue;
      candidates.push({ out, peak: peaks.values[i] });
    }
    outOffset += seg.endSec - seg.startSec;
  }
  // 只把「够响」的时刻当峰:低于最高峰一半的是过渡段,拿去当变体封面
  // 就不是情绪高点了;全程近静音(<0.05)保持旧行为回退固定帧
  const maxPeak = candidates.reduce((m, c) => Math.max(m, c.peak), 0);
  const floor = Math.max(0.05, maxPeak * 0.5);
  const strong = candidates.filter((c) => c.peak >= floor);
  // 按峰值从高到低贪心选互不相邻的峰:第 1 名就是历史的 argmax,行为不变
  strong.sort((a, b) => b.peak - a.peak);
  const picked: Array<{ out: number; peak: number }> = [];
  for (const c of strong) {
    if (picked.some((p) => Math.abs(p.out - c.out) < PEAK_MIN_GAP_SEC)) continue;
    picked.push(c);
    if (picked.length > rank) break;
  }
  // 峰不够多时用最后一个真峰(宁重复,不拿噪声底当封面)
  const chosen = picked[Math.min(rank, picked.length - 1)];
  return chosen ? chosen.out : fallback;
}
