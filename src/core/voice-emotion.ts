/**
 * 语音情绪 / 音频事件信号:SenseVoice 每次解码除了文本,本来就顺带输出
 * 整段的情绪标签(<|HAPPY|>/<|ANGRY|>…)和音频事件标签(<|Laughter|>/
 * <|Applause|>…)——转写档已经在用的同一个模型、同一份权重,只是这两个
 * 字段一直没被读。这里用短窗重扫把它们变成带时间的证据:
 *   - 说话人情绪激动时段(笑着说/吼出来/惊到了)
 *   - 笑声 / 掌声 / 哭腔时段(现场反应,不在文字稿里)
 * 两者都是「文字稿看不见的爆点」:同一句话平铺直叙还是笑场,只有声音知道。
 *
 * 零新模型、零新体积——复用 SenseVoice 模型目录。
 *
 * 成本控制与表情信号(emotion.ts)同款:只在响度峰值/镜头密集段里密集扫,
 * 均匀网格兜底,窗数与总时长都封顶。全程 fail-open:模型缺失/解码失败/
 * 预算耗尽都只是没有该信号,绝不拖垮检测。纯函数(标签解析/窗口规划/
 * 命中合并)可单测,sherpa 解码通过注入点替换。
 */
import { join } from "path";
import { rm } from "fs/promises";
import { tmpdir } from "os";
import { resolveFfmpegPath } from "./binaries";
import { extractPcmF32le16k, isModelInstalled, modelDir, readF32leSamples, SENSEVOICE_MODEL } from "./models";
import { toAnsiSafeDir } from "./win-ansi-path";
import { loadSherpa, type SherpaResult } from "./transcribe/sherpa-offline";
import { planSignalGuidedTimes, type MediaSignals, type TimeRange } from "./signals";

/** 单个扫描窗时长(SenseVoice 是整段分类,太短没上下文、太长会被中性稀释)。 */
export const VOICE_WINDOW_SEC = 6;
/** 扫描窗数上限(窗数 × 窗长 = 实际解码音频量,直接决定耗时)。 */
export const VOICE_MAX_WINDOWS = 100;
/** 信号窗口内的扫描步长。 */
export const VOICE_WINDOW_STEP_SEC = 5;
/** 两窗中心最小间隔(略小于窗长,允许相邻窗轻微重叠不漏边界)。 */
export const VOICE_MIN_SPACING_SEC = 5;
/** 相邻命中窗间隔小于该值时并成一段。 */
const MERGE_GAP_SEC = 4;
/** 每路信号圈出的时段上限(提示词别塞爆)。 */
const MAX_RANGES = 12;
/** 总预算:超时带着已得结果收工。 */
const VOICE_BUDGET_MS = 90_000;
/** 成功解码的窗少于该数时证据太薄,不给信号。 */
const MIN_SCORED_WINDOWS = 3;
/**
 * 饱和阈值:某路标签命中率超过它就整路丢弃。实测发现 SenseVoice 把「有活力
 * 地说话」普遍判成 HAPPY——主播全程亢奋时这路会退化成常量,"全片都是爆点"
 * 等于没有爆点,塞进提示词只会稀释其他证据。宁可没有信号,不要假信号。
 *
 * 阈值定得很高(0.9),因为超额的时段先由 topByDuration 按时长排序筛过一轮:
 * 脱口秀这类全程有笑声的素材(实测 62% 的窗命中笑声),真正该丢的不是整路
 * 信号,而是那些一闪而过的礼貌笑——留下笑得最久的几波才是爆点。只有几乎
 * 每一窗都命中、排序也失去意义时才整路放弃。
 */
const SATURATION_RATIO = 0.9;

/**
 * 计入「情绪激动」的 SenseVoice 情绪标签。与表情信号(FER+ 取笑/惊/怒)
 * 保持同一套爆点三情绪:高兴、生气、惊讶。NEUTRAL/SAD/DISGUSTED 不计——
 * 平铺直叙和低落情绪不是切片爆点,计进去只会稀释信号。
 */
const HOT_EMOTIONS = new Set(["HAPPY", "ANGRY", "SURPRISED"]);
/**
 * 计入「现场反应」的音频事件标签。BGM/Speech/Breath 不计(垫场与常态),
 * 笑声、掌声、哭腔才是文字稿里看不到的爆点证据。
 */
const HOT_EVENTS = new Set(["LAUGHTER", "APPLAUSE", "CRY"]);

export interface VoiceTagStats {
  windowsPlanned: number;
  /** 实际完成解码的窗数。 */
  windowsScored: number;
  emotionPeakCount: number;
  eventPeakCount: number;
  /** 该路命中率过高被判定为无区分度而整路丢弃(见 SATURATION_RATIO)。 */
  emotionSaturated?: boolean;
  eventSaturated?: boolean;
}

export interface VoiceEmotionOutcome {
  /** 说话人情绪激动时段(笑着说/吼/惊)。 */
  voiceEmotionPeaks: TimeRange[];
  /** 笑声/掌声/哭腔时段(现场反应)。 */
  audioEventPeaks: TimeRange[];
  stats: VoiceTagStats;
}

/**
 * 剥 SenseVoice 的 `<|TAG|>` 包装并归一成大写:`"<|HAPPY|>"` → `"HAPPY"`。
 * 非标签原样返回(模型换版本改了格式也不会炸)。纯函数。
 */
export function stripSenseVoiceTag(raw: string | undefined | null): string {
  if (!raw) return "";
  const m = raw.match(/<\|([^|>]+)\|>/);
  return (m ? m[1] : raw).trim().toUpperCase();
}

/** 该情绪标签算不算「情绪激动」。纯函数。 */
export function isHotEmotion(tag: string | undefined | null): boolean {
  return HOT_EMOTIONS.has(stripSenseVoiceTag(tag));
}

/** 该事件标签算不算「现场反应」。纯函数。 */
export function isHotEvent(tag: string | undefined | null): boolean {
  return HOT_EVENTS.has(stripSenseVoiceTag(tag));
}

/**
 * 规划扫描窗:信号窗口内密集、均匀网格兜底(与表情信号同款预算策略),
 * 返回窗口的 [起, 止],已夹进片内且按时间排序。纯函数。
 */
export function planVoiceScanWindows(
  durationSec: number,
  signals: MediaSignals | undefined,
  maxWindows = VOICE_MAX_WINDOWS,
  windowSec = VOICE_WINDOW_SEC
): TimeRange[] {
  if (!(durationSec > 1)) return [];
  const centers = planSignalGuidedTimes(
    durationSec,
    signals,
    maxWindows,
    VOICE_MIN_SPACING_SEC,
    VOICE_WINDOW_STEP_SEC,
    windowSec / 2
  );
  const half = windowSec / 2;
  return centers.map((c) => {
    const startSec = Math.max(0, Math.min(c - half, durationSec - windowSec));
    return { startSec: Math.max(0, startSec), endSec: Math.min(durationSec, startSec + windowSec) };
  });
}

/**
 * 命中窗 → 时段:相邻(间隔 ≤ mergeGapSec)的命中窗并成一段。
 * 输入需按时间有序。纯函数。
 */
export function mergeHitWindows(hits: TimeRange[], mergeGapSec = MERGE_GAP_SEC): TimeRange[] {
  const out: TimeRange[] = [];
  for (const h of hits) {
    const last = out[out.length - 1];
    if (last && h.startSec - last.endSec <= mergeGapSec) last.endSec = Math.max(last.endSec, h.endSec);
    else out.push({ startSec: h.startSec, endSec: h.endSec });
  }
  return out;
}

/**
 * 时段超额时按**时长**降序取前 max,再按时间排回。
 * 直接截前 max 个等于「只看片头」;而笑声/激动持续得越久,现场反应越强,
 * 时长本身就是强弱的代理指标——脱口秀全程有笑时,靠它挑出最炸的那几波。
 * 纯函数。
 */
export function topByDuration(ranges: TimeRange[], max: number): TimeRange[] {
  if (ranges.length <= max) return ranges;
  return [...ranges]
    .sort((a, b) => b.endSec - b.startSec - (a.endSec - a.startSec))
    .slice(0, max)
    .sort((a, b) => a.startSec - b.startSec);
}

/** 一个窗的解码结果(只关心两个标签,文本丢弃)。 */
export interface VoiceWindowTags {
  emotion: string;
  event: string;
}

export interface VoiceEmotionDeps {
  /** 解码 [startSec, endSec) 这一窗,返回情绪/事件标签;null 表示该窗不可用(跳过不计数)。 */
  tagWindow: (startSec: number, endSec: number) => Promise<VoiceWindowTags | null>;
}

/** SenseVoice 短窗打标器:复用转写档的模型目录,只读 emotion/event 字段。 */
export class VoiceTagger {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  private recognizer: any = null;

  constructor(private modelsRoot: string) {}

  async init(): Promise<void> {
    const sh = loadSherpa();
    // 模型文件由原生层自己打开(ANSI):Windows 中文路径先转 8.3 短路径(issue #4)
    const dir = await toAnsiSafeDir(modelDir(this.modelsRoot, SENSEVOICE_MODEL));
    this.recognizer = new sh.OfflineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        senseVoice: { model: join(dir, "model.int8.onnx"), useInverseTextNormalization: 0 },
        tokens: join(dir, "tokens.txt"),
        numThreads: 2,
        provider: "cpu",
        debug: 0,
      },
    });
  }

  async tag(samples: Float32Array): Promise<VoiceWindowTags> {
    const stream = this.recognizer.createStream();
    stream.acceptWaveform({ sampleRate: 16000, samples });
    this.recognizer.decode(stream);
    const r = this.recognizer.getResult(stream) as SherpaResult & { emotion?: string; event?: string };
    return { emotion: stripSenseVoiceTag(r.emotion), event: stripSenseVoiceTag(r.event) };
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * 采集语音情绪 / 音频事件信号。fail-open:
 * - SenseVoice 模型未安装(用户用的是云端/其他转写档) → null;
 * - 抽音频或初始化失败 → null;
 * - 单窗解码失败 → 跳过该窗;
 * - 成功窗数不足 MIN_SCORED_WINDOWS → null;
 * - 超总预算 → 带着已得结果收工。
 */
export async function collectVoiceEmotionSignal(opts: {
  videoPath: string;
  durationSec: number;
  modelsRoot: string;
  signals?: MediaSignals;
  deps?: VoiceEmotionDeps;
  budgetMs?: number;
}): Promise<VoiceEmotionOutcome | null> {
  const { videoPath, durationSec, modelsRoot, signals, budgetMs = VOICE_BUDGET_MS } = opts;
  const windows = planVoiceScanWindows(durationSec, signals);
  if (windows.length === 0) return null;

  // 注入依赖时(测试)不碰磁盘;否则要求模型已就位——这里绝不触发下载,
  // 用户可能压根没用本地转写档,不该为一路辅助信号偷偷下 170MB。
  if (!opts.deps && !(await isModelInstalled(modelsRoot, SENSEVOICE_MODEL).catch(() => false))) return null;

  const pcmPath = join(tmpdir(), `hotclip-voicetag-${Date.now()}-16k.f32le`);
  try {
    let deps = opts.deps;
    if (!deps) {
      await extractPcmF32le16k(resolveFfmpegPath(), videoPath, pcmPath);
      const samples = await readF32leSamples(pcmPath);
      const tagger = new VoiceTagger(modelsRoot);
      await tagger.init();
      const sampleRate = 16000;
      deps = {
        tagWindow: async (startSec, endSec) => {
          const from = Math.floor(startSec * sampleRate);
          const to = Math.min(samples.length, Math.floor(endSec * sampleRate));
          if (to - from < sampleRate) return null; // 不足 1s 的尾窗没有分类价值
          return tagger.tag(samples.subarray(from, to));
        },
      };
    }

    const deadline = Date.now() + budgetMs;
    const emotionHits: TimeRange[] = [];
    const eventHits: TimeRange[] = [];
    let windowsScored = 0;

    for (const w of windows) {
      if (Date.now() > deadline) break; // 预算耗尽,带着已得结果收工
      try {
        const tags = await deps.tagWindow(w.startSec, w.endSec);
        if (!tags) continue;
        windowsScored++;
        if (isHotEmotion(tags.emotion)) emotionHits.push(w);
        if (isHotEvent(tags.event)) eventHits.push(w);
      } catch {
        // 单窗失败跳过
      }
    }

    if (windowsScored < MIN_SCORED_WINDOWS) return null;
    // 饱和的那一路整路丢弃(见 SATURATION_RATIO):全片都命中 = 没有区分度
    const emotionSaturated = emotionHits.length > windowsScored * SATURATION_RATIO;
    const eventSaturated = eventHits.length > windowsScored * SATURATION_RATIO;
    const voiceEmotionPeaks = emotionSaturated ? [] : topByDuration(mergeHitWindows(emotionHits), MAX_RANGES);
    const audioEventPeaks = eventSaturated ? [] : topByDuration(mergeHitWindows(eventHits), MAX_RANGES);
    return {
      voiceEmotionPeaks,
      audioEventPeaks,
      stats: {
        windowsPlanned: windows.length,
        windowsScored,
        emotionPeakCount: voiceEmotionPeaks.length,
        eventPeakCount: audioEventPeaks.length,
        emotionSaturated,
        eventSaturated,
      },
    };
  } catch {
    return null; // 抽音频/模型初始化失败:静默没有该信号
  } finally {
    await rm(pcmPath, { force: true });
  }
}
