/**
 * 自动运镜(Auto-Zoom):给竖屏成片叠一层缓慢的推拉镜头。固定机位的口播/
 * 直播素材切成竖屏后画面是死的,观众三秒就划走;人工剪辑会手动加关键帧
 * 推近拉远制造呼吸感——这里把它自动化。
 *
 * 策略是"呼吸式"而不是一路推到底:全程单向推近会让后半段构图越来越紧、
 * 人头顶被切掉;这里在基准与推近之间来回,周期约 10 秒。给了强调时刻
 * (爆点/响度峰值)就在那些点推到最近,让镜头语言和内容对上。
 *
 * 几何上靠 ffmpeg 的 zoompan 实现——crop 的 w/h 只在初始化求值一次,
 * 做不了逐帧缩放,zoompan 是唯一能逐帧改景别的滤镜。表达式编译方式与
 * 人脸追踪的 crop-x 同款(分段线性,关键帧封顶控制嵌套深度)。纯函数可单测。
 */

/** 基准景别(1 = 不缩放,画面完整)。 */
export const ZOOM_BASE = 1.0;
/** 呼吸推近的峰值倍率(超过 1.1 明显裁掉构图,克制为上)。 */
export const ZOOM_BREATH = 1.06;
/** 强调时刻的推近倍率。 */
export const ZOOM_EMPHASIS = 1.1;
/** 一个完整呼吸周期(推近+回落)的秒数。 */
export const ZOOM_CYCLE_SEC = 10;
/** 短于该时长的切片不做运镜(还没推到位片子就结束了,只会显得晃)。 */
export const ZOOM_MIN_CLIP_SEC = 4;
/** 强调推近的前置提前量:镜头先动、内容后到,观感才是"跟上了"。 */
const EMPHASIS_LEAD_SEC = 0.4;
/** 强调推近的持续时长。 */
const EMPHASIS_HOLD_SEC = 1.6;
/** 表达式关键帧上限(与 renderCropXExpr 同量级,防嵌套过深)。 */
const MAX_ZOOM_KEYFRAMES = 24;

export interface ZoomKeyframe {
  /** 切片内相对时间(秒)。 */
  t: number;
  /** 缩放倍率(≥1)。 */
  z: number;
}

export interface AutoZoomOptions {
  /** 强调时刻(切片内相对秒),通常来自爆点/响度峰值。 */
  emphasisAtSec?: number[];
  breathZoom?: number;
  emphasisZoom?: number;
  cycleSec?: number;
}

/**
 * 规划缩放关键帧。无强调时刻时是纯呼吸节奏;有强调时刻则在其附近
 * 覆盖为推近-保持-回落,并丢掉被覆盖的呼吸关键帧(免得镜头打架)。
 * 纯函数。
 */
export function planZoomKeyframes(durationSec: number, options: AutoZoomOptions = {}): ZoomKeyframe[] {
  if (!(durationSec >= ZOOM_MIN_CLIP_SEC)) return [];
  const breath = options.breathZoom ?? ZOOM_BREATH;
  const emphasis = options.emphasisZoom ?? ZOOM_EMPHASIS;
  const cycle = Math.max(2, options.cycleSec ?? ZOOM_CYCLE_SEC);

  // 呼吸:0 → 半周期推到 breath → 整周期回到基准,如此往复
  const breathing: ZoomKeyframe[] = [{ t: 0, z: ZOOM_BASE }];
  for (let t = cycle / 2; t < durationSec; t += cycle / 2) {
    const atPeak = Math.round((t / (cycle / 2))) % 2 === 1;
    breathing.push({ t, z: atPeak ? breath : ZOOM_BASE });
  }

  const emphases = (options.emphasisAtSec ?? [])
    .filter((t) => Number.isFinite(t) && t >= 0 && t < durationSec)
    .sort((a, b) => a - b);
  if (emphases.length === 0) return dedupe(breathing, durationSec);

  // 先把强调时刻展开成窗口并合并重叠的,再统一铺关键帧——分开做才不会出现
  // 「前一段刚回落、后一段立刻猛推」的抽搐
  const spans: Array<{ from: number; at: number; holdEnd: number; to: number }> = [];
  for (const at of emphases) {
    const from = Math.max(0, at - EMPHASIS_LEAD_SEC);
    const holdEnd = Math.min(durationSec, at + EMPHASIS_HOLD_SEC);
    const to = Math.min(durationSec, holdEnd + EMPHASIS_LEAD_SEC);
    const last = spans[spans.length - 1];
    if (last && from <= last.to) {
      // 挨得近:并成一个长推近,推近点仍是第一个强调(镜头到位后一直保持)
      last.holdEnd = Math.max(last.holdEnd, holdEnd);
      last.to = Math.max(last.to, to);
      continue;
    }
    spans.push({ from, at, holdEnd, to });
  }
  const marks: ZoomKeyframe[] = [];
  for (const s of spans) {
    marks.push(
      { t: s.from, z: ZOOM_BASE },
      { t: s.at, z: emphasis },
      { t: s.holdEnd, z: emphasis },
      { t: s.to, z: ZOOM_BASE }
    );
  }
  // 落在强调窗里(含端点)的呼吸关键帧丢掉,免得和强调曲线打架
  const kept = breathing.filter((k) => !spans.some((s) => k.t >= s.from && k.t <= s.to));
  return dedupe([...kept, ...marks].sort((a, b) => a.t - b.t), durationSec);
}

/** 去掉同一时刻的重复关键帧,并保证首帧在 0。 */
function dedupe(kfs: ZoomKeyframe[], durationSec: number): ZoomKeyframe[] {
  const out: ZoomKeyframe[] = [];
  for (const k of kfs) {
    if (k.t > durationSec) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last.t - k.t) < 1e-3) {
      last.z = Math.max(last.z, k.z); // 同刻取更近的那个
      continue;
    }
    out.push({ t: k.t, z: k.z });
  }
  if (out.length > 0 && out[0].t > 0) out.unshift({ t: 0, z: ZOOM_BASE });
  return out;
}

/** 均匀降采样(保首尾),与 downsampleKeyframes 同款。 */
function downsample(kfs: ZoomKeyframe[], max: number): ZoomKeyframe[] {
  if (kfs.length <= max) return kfs;
  const out: ZoomKeyframe[] = [];
  for (let i = 0; i < max; i++) out.push(kfs[Math.round((i * (kfs.length - 1)) / (max - 1))]);
  return out;
}

/**
 * 关键帧编译成 zoompan 的 z 表达式(以 in_time 为自变量的分段线性插值)。
 * 无关键帧时返回 "1"(等价于不缩放)。纯函数。
 */
export function renderZoomExpr(keyframes: ZoomKeyframe[], maxKeyframes = MAX_ZOOM_KEYFRAMES): string {
  const kfs = downsample(keyframes, maxKeyframes).filter((k, i, arr) => i === 0 || k.t > arr[i - 1].t + 1e-4);
  if (kfs.length === 0) return "1";
  const fmt = (z: number): string => z.toFixed(4);
  if (kfs.length === 1) return fmt(kfs[0].z);
  let expr = fmt(kfs[kfs.length - 1].z);
  for (let i = kfs.length - 2; i >= 0; i--) {
    const a = kfs[i];
    const b = kfs[i + 1];
    const dt = (b.t - a.t).toFixed(4);
    const seg = `${fmt(a.z)}+${(b.z - a.z).toFixed(4)}*(in_time-${a.t.toFixed(3)})/${dt}`;
    expr = `if(lt(in_time,${b.t.toFixed(3)}),${seg},${expr})`;
  }
  return expr;
}

/**
 * 完整的 zoompan 滤镜串:居中缩放并输出到目标尺寸。
 * `fps` 必须传源帧率——zoompan 的 fps 默认 25,不传会把素材重采样到 25fps。
 * 返回 null 表示这条切片不该做运镜(太短/关键帧为空),调用方退回原来的 scale。
 */
export function buildZoomFilter(
  durationSec: number,
  fps: number,
  outW: number,
  outH: number,
  options: AutoZoomOptions = {}
): string | null {
  const kfs = planZoomKeyframes(durationSec, options);
  if (kfs.length === 0) return null;
  if (!(fps > 0)) return null; // 帧率未知时不冒险(会被重采样)
  const z = renderZoomExpr(kfs);
  // x/y 居中:人脸追踪已把主体放在裁剪窗中心,居中放大不会把脸推出画面
  return (
    `zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${outW}x${outH}:fps=${fps}`
  );
}
