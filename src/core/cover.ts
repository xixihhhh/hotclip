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

/**
 * 在保留区间内找响度最高的时刻,并映射到输出时间轴。
 * 找不到可靠峰(无轨/全静音/时长太短)回退固定帧。
 */
export function pickCoverTime(
  peaks: PeakTrack | undefined,
  ranges: KeptSegment[],
  durationSec: number
): number {
  const fallback = fallbackCoverTime(durationSec);
  if (!peaks || peaks.values.length === 0 || durationSec <= EDGE_GUARD_SEC * 2 || ranges.length === 0) {
    return fallback;
  }
  let bestOut = -1;
  let bestPeak = 0;
  let outOffset = 0;
  for (const seg of ranges) {
    for (let i = 0; i < peaks.values.length; i++) {
      const t = peaks.startSec + i * peaks.hopSec; // 源时间
      if (t < seg.startSec || t >= seg.endSec) continue;
      const out = outOffset + (t - seg.startSec); // 输出时间
      if (out < EDGE_GUARD_SEC || out > durationSec - EDGE_GUARD_SEC) continue;
      if (peaks.values[i] > bestPeak) {
        bestPeak = peaks.values[i];
        bestOut = out;
      }
    }
    outOffset += seg.endSec - seg.startSec;
  }
  // 峰值太弱(全程近静音)时选帧无意义,保持旧行为可预期
  return bestOut >= 0 && bestPeak >= 0.05 ? bestOut : fallback;
}
