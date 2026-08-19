/**
 * 信号驱动的候选通道:不靠文字稿定位爆点。
 *
 * 为什么必须有:HotClip 原本整条链路是「LLM 引用原话 → 反查时间轴」,这对
 * 带货/讲课/访谈成立,但对**跳舞、才艺、户外**根本不成立——跳舞直播的文字稿
 * 是空的(只有零散寒暄),户外收音差、峰值时刻的话常常只有"卧槽"两个字。
 * 没有可引用的原话 = 一条候选都出不来,品类判据写得再好也救不回来。
 *
 * 所以这里换一条路:把七路视听信号(响度/镜头切换/视觉模型/表情/语气/笑声
 * 掌声/弹幕)按品类权重融合成一条时间轴热度曲线,直接从曲线上取窗口。
 * 时间由信号给,LLM 只负责在这些窗口里挑哪几个值得发、起什么标题——
 * 它不需要引用任何原话,自然也就不会因为"没话可引"而交白卷。
 *
 * 纯函数,可单测;不碰 ffmpeg、不发网络请求。
 */
import type { MediaSignals } from "../signals";
import type { Transcript } from "../transcribe/types";
import type { EvidenceClass } from "../genre";

export interface TimeRange {
  startSec: number;
  endSec: number;
}

/** 七路信号各自的权重(融合曲线用)。 */
export interface MomentWeights {
  loud: number;
  cut: number;
  visual: number;
  emotion: number;
  voice: number;
  audioEvent: number;
  danmaku: number;
}

/**
 * 按证据类别给权重。这两套权重几乎是反的,这正是「不同品类证据权重相反」
 * 那条调研结论落到代码里的样子:
 *  - visual(跳舞/才艺/唱歌):画面和弹幕说了算,语气基本没用(表演时不说话)
 *  - reaction(游戏/户外/聊天):语气爆发和弹幕是主证据,画面只作参考
 */
export const MOMENT_WEIGHTS: Record<Exclude<EvidenceClass, "words">, MomentWeights> = {
  visual: { loud: 1.2, cut: 2.5, visual: 3, emotion: 1.5, voice: 0.5, audioEvent: 1, danmaku: 3 },
  reaction: { loud: 2, cut: 1, visual: 1.5, emotion: 2, voice: 3, audioEvent: 2.5, danmaku: 3 },
};

/** 热度曲线的采样粒度。1 秒足够——再细也超出信号本身的分辨率。 */
export const MOMENT_BIN_SEC = 1;
/** 峰与峰之间至少隔这么久,避免同一个高潮被切成好几条。 */
export const MOMENT_MIN_GAP_SEC = 8;
/** 内部最多融合出多少个时刻。 */
export const MOMENT_MAX_COUNT = 12;
/**
 * 真正塞进提示词的上限(按热度取前 N,再按时间排回)。
 * 实测教训:12 条 × 每条 25 秒的噪声转写堆进提示词,模型会直接吐回未填写的
 * 模板(`"momentId": x`);砍到 8 条并截短参考原话后一次成功。提示词本身也说
 * 「真正值得剪的通常只有两三个」,给 12 个选项本来就自相矛盾。
 */
export const MOMENT_PROMPT_MAX = 8;

/** 按热度取前 N,再按时间排回并重新编号(编号必须与提示词里一致)。 */
export function topMoments(moments: SignalMoment[], max = MOMENT_PROMPT_MAX): SignalMoment[] {
  if (moments.length <= max) return moments;
  return [...moments]
    .sort((a, b) => b.heat - a.heat)
    .slice(0, max)
    .sort((a, b) => a.startSec - b.startSec)
    .map((m, i) => ({ ...m, id: i + 1 }));
}
/**
 * 单路信号覆盖超过这个比例就判为"一直在响",权重打折。
 * 这条是 SenseVoice 情绪饱和那次踩出来的:中性播音也判 HAPPY、脱口秀 62% 的
 * 窗口都有笑声——一路信号如果全程都亮,它就不再有区分度。
 */
export const MOMENT_SATURATION = 0.55;
/**
 * 多路共振加成:同一秒被越多种信号同时命中越可信——只有音量高可能是 BGM,
 * 只有弹幕高可能是刷屏,音量+弹幕+笑声一起亮才是真爆点。每多一路乘一档。
 * 提示词早就告诉 LLM「单路孤证可以放心丢」;这里把同一judgement落进曲线,
 * 让共振时刻在排序上直接压过孤证。
 */
export const MOMENT_AGREEMENT_BONUS = 0.25;
/**
 * 峰值低于最强峰的该比例时停止取窗——弱尾巴是噪声(某路低权信号的一闪),
 * 塞给 LLM 只会稀释真候选。相对比例而非绝对阈值:信号贫瘠的素材照样出峰。
 */
export const MOMENT_NOISE_FLOOR = 0.25;
/** 取窗时向两侧扩到热度跌破峰值的该比例为止——窗口随内容伸缩,不再一刀切。 */
export const MOMENT_WINDOW_REL_HEIGHT = 0.35;

export interface SignalMoment {
  /** 1-based,给 LLM 引用用(它只需要报编号,不需要引用原话)。 */
  id: number;
  startSec: number;
  endSec: number;
  /** 融合热度(相对值,同一场内可比)。 */
  heat: number;
  /** 命中的信号种类(展示给 LLM 和用户的证据链)。 */
  evidence: Array<keyof MomentWeights>;
}

/**
 * 说话占比:各句时长之和 / 总时长。语言无关(不数字符),所以中英文都适用。
 * 跳舞/唱歌直播大段时间没人说话,这个值会很低。
 */
export function speechRatio(transcript: Transcript): number {
  if (transcript.durationSec <= 0) return 0;
  const spoken = transcript.segments.reduce((a, s) => a + Math.max(0, s.endSec - s.startSec), 0);
  return Math.min(1, spoken / transcript.durationSec);
}

/** 低于这个说话占比就当"文字稿基本没东西",不管用户选了什么品类都补跑信号通道。 */
export const SPARSE_SPEECH_RATIO = 0.35;

/**
 * 要不要跑信号通道。三个触发条件任一成立即跑:
 *  ① 品类本身就是靠反应/画面的(用户明确选了游戏/户外/才艺)
 *  ② 说话占比过低——素材自己说明了文字稿没内容(兜住没枚举到的品类)
 *  ③ 文本通道产出太少——引不出原话时的最后一道保险
 */
export function shouldRunMoments(
  evidence: EvidenceClass,
  ratio: number,
  textCandidateCount: number
): boolean {
  return evidence !== "words" || ratio < SPARSE_SPEECH_RATIO || textCandidateCount < 2;
}

/** 某路信号的总覆盖时长占比——用于饱和打折。 */
function coverageRatio(ranges: TimeRange[] | undefined, durationSec: number): number {
  if (!ranges || ranges.length === 0 || durationSec <= 0) return 0;
  const total = ranges.reduce((a, r) => a + Math.max(0, r.endSec - r.startSec), 0);
  return Math.min(1, total / durationSec);
}

/**
 * 把一路信号加进热度数组。覆盖过广的信号按覆盖率反比打折——全程都亮的信号
 * 没有区分度,不打折会把曲线压平、峰值退化成随机。
 */
function addSignal(
  heat: Float64Array,
  hits: Array<Set<keyof MomentWeights>>,
  ranges: TimeRange[] | undefined,
  weight: number,
  kind: keyof MomentWeights,
  binSec: number,
  durationSec: number
): void {
  if (!ranges || ranges.length === 0 || weight <= 0) return;
  const cov = coverageRatio(ranges, durationSec);
  const w = cov > MOMENT_SATURATION ? weight * (MOMENT_SATURATION / cov) : weight;
  for (const r of ranges) {
    const from = Math.max(0, Math.floor(r.startSec / binSec));
    const to = Math.min(heat.length - 1, Math.ceil(r.endSec / binSec));
    for (let i = from; i <= to; i++) {
      heat[i] += w;
      hits[i].add(kind);
    }
  }
}

/** 三点移动平均:抹掉单格抖动,峰值位置更稳。 */
function smooth(heat: Float64Array): Float64Array {
  const out = new Float64Array(heat.length);
  for (let i = 0; i < heat.length; i++) {
    const a = heat[Math.max(0, i - 1)];
    const c = heat[Math.min(heat.length - 1, i + 1)];
    out[i] = (a + heat[i] * 2 + c) / 4;
  }
  return out;
}

export interface FuseOptions {
  weights: MomentWeights;
  /** 目标片长下限/上限(秒),与切片时长档一致。 */
  minSec: number;
  maxSec: number;
  maxCount?: number;
  binSec?: number;
}

/**
 * 融合七路信号 → 按热度排序的时刻清单。
 *
 * 取窗口的办法:反复取当前最热的一格,从峰向两侧扩到热度跌破峰值比例
 * (窗口随内容伸缩:碎峰给短窗、持续高潮给长窗,都夹在目标片长档内),
 * 然后把这一段(加上最小间隔)标记已取再找下一个——保证彼此不重叠、
 * 不扎堆;峰值弱到只剩最强峰的零头时收工,弱尾噪声不进清单。
 */
export function fuseMoments(
  signals: MediaSignals | undefined,
  durationSec: number,
  options: FuseOptions
): SignalMoment[] {
  const binSec = options.binSec ?? MOMENT_BIN_SEC;
  const maxCount = options.maxCount ?? MOMENT_MAX_COUNT;
  if (!signals || durationSec <= 0) return [];

  const bins = Math.max(1, Math.ceil(durationSec / binSec));
  const heat = new Float64Array(bins);
  const hits: Array<Set<keyof MomentWeights>> = Array.from({ length: bins }, () => new Set<keyof MomentWeights>());
  const w = options.weights;
  addSignal(heat, hits, signals.loudPeaks, w.loud, "loud", binSec, durationSec);
  addSignal(heat, hits, signals.cutDense, w.cut, "cut", binSec, durationSec);
  addSignal(heat, hits, signals.visualPeaks, w.visual, "visual", binSec, durationSec);
  addSignal(heat, hits, signals.emotionPeaks, w.emotion, "emotion", binSec, durationSec);
  addSignal(heat, hits, signals.voiceEmotionPeaks, w.voice, "voice", binSec, durationSec);
  addSignal(heat, hits, signals.audioEventPeaks, w.audioEvent, "audioEvent", binSec, durationSec);
  addSignal(heat, hits, signals.danmakuPeaks, w.danmaku, "danmaku", binSec, durationSec);

  // 多路共振加成:加权求和之后,再按同秒命中的信号路数乘档——孤证不奖励
  for (let i = 0; i < bins; i++) {
    const extra = hits[i].size - 1;
    if (extra > 0) heat[i] *= 1 + MOMENT_AGREEMENT_BONUS * extra;
  }

  const curve = smooth(heat);
  const minBins = Math.max(1, Math.round(options.minSec / binSec));
  const maxBins = Math.max(minBins, Math.round(options.maxSec / binSec));
  const gapBins = Math.max(1, Math.round(MOMENT_MIN_GAP_SEC / binSec));

  const out: SignalMoment[] = [];
  const taken = new Uint8Array(bins);
  let strongest = 0;
  for (let n = 0; n < maxCount; n++) {
    let best = -1;
    let bestVal = 0;
    for (let i = 0; i < bins; i++) {
      if (taken[i]) continue;
      if (curve[i] > bestVal) {
        bestVal = curve[i];
        best = i;
      }
    }
    if (best < 0 || bestVal <= 0) break;
    if (strongest === 0) strongest = bestVal;
    else if (bestVal < strongest * MOMENT_NOISE_FLOOR) break; // 弱尾噪声收工

    // 从峰向两侧扩:热度跌破峰值比例、撞上已取格或素材边界就停
    const floor = bestVal * MOMENT_WINDOW_REL_HEIGHT;
    let from = best;
    let to = best;
    while (to - from + 1 < maxBins) {
      const left = from > 0 && !taken[from - 1] && curve[from - 1] >= floor ? curve[from - 1] : -1;
      const right = to < bins - 1 && !taken[to + 1] && curve[to + 1] >= floor ? curve[to + 1] : -1;
      if (left < 0 && right < 0) break;
      if (right >= left) to++;
      else from--;
    }
    // 碎峰太短的补到目标下限(仍不越过已取格/边界)——凑出能看完整内容的窗
    while (to - from + 1 < minBins) {
      const canLeft = from > 0 && !taken[from - 1];
      const canRight = to < bins - 1 && !taken[to + 1];
      if (!canLeft && !canRight) break;
      if (canRight && (!canLeft || curve[to + 1] >= curve[from - 1])) to++;
      else from--;
    }
    // 证据取窗口内出现过的所有信号种类(而不是只看峰值那一格)
    const kinds = new Set<keyof MomentWeights>();
    for (let i = from; i <= to; i++) {
      for (const k of hits[i]) kinds.add(k);
    }
    out.push({
      id: 0, // 排序后统一编号
      startSec: Number((from * binSec).toFixed(2)),
      endSec: Number(Math.min(durationSec, (to + 1) * binSec).toFixed(2)),
      // 热度记峰值强度(不是窗内求和)——长窗不因长度占排序便宜
      heat: Number(bestVal.toFixed(3)),
      evidence: [...kinds],
    });
    for (let i = Math.max(0, from - gapBins); i <= Math.min(bins - 1, to + gapBins); i++) taken[i] = 1;
  }

  // 交给 LLM 时按时间排(它要能看出先后),编号也按时间走
  return out
    .sort((a, b) => a.startSec - b.startSec)
    .map((m, i) => ({ ...m, id: i + 1 }));
}
