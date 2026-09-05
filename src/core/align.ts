import { matchingCharacters, paraformerSupportsText } from "../shared/speech-text";
/**
 * 精准切点(二遍对齐):导出期只对进入决赛的候选片段,用 Paraformer
 * (sherpa-onnx-paraformer-zh-2023-09-14,唯一支持时间戳的档)重解码一遍,
 * 拿 CIF 一体化词级时间戳修正主转写的词表——字幕卡拉OK、跳剪、冷开场、
 * SRT 全部受益。
 *
 * 为什么不换主 ASR:SenseVoice 的情绪/音频事件标签是第七八路证据的来源,
 * Paraformer 没有;而 Paraformer 的 CIF 时间戳精度(官方宣称超过 Kaldi
 * 强制对齐,±50ms 级)正是 SenseVoice 一侧的短板——各取所长,候选段才
 * 几十秒,二遍解码的代价可忽略。(方案出处:FunClip 拆解调研,2026-08-05)
 *
 * refineWordTimings 是纯函数(字符级 LCS 对齐+时间重映射),可单测;
 * createClipAligner 才碰模型与 ffmpeg。任何失败/低匹配率都返回 null,
 * 调用方回退原词表——精对齐是锦上添花,绝不拖垮导出。
 */
import { join } from "path";
import { tmpdir } from "os";
import { rm } from "fs/promises";
import { resolveFfmpegPath } from "./binaries";
import {
  ensureModel,
  extractPcmF32le16k,
  modelDir,
  readF32leSamples,
  PARAFORMER_MODEL,
} from "./models";
import { toAnsiSafeDir } from "./win-ansi-path";
import { loadSherpa, tokensToWords, type SherpaResult } from "./transcribe/sherpa-offline";
import type { AlignmentQualityReport, TranscriptWord } from "../shared/api-types";
import type { ClipPiece } from "../shared/pieces";
import { summarizeTimingQuality } from "../shared/transcript-quality";

/** 匹配率低于此不采纳(转写幻觉/背景音乐段,对齐结果不可信)。 */
export const ALIGN_MIN_MATCH_FRAC = 0.5;
/** 候选段两侧解码余量(秒):边界词的完整发音要包进来。 */
const ALIGN_PAD_SEC = 0.4;
/** 二遍解码的窗口(与主转写同参)。 */
const ALIGN_WINDOW_SEC = 28;
/** 词最短时长(秒):重映射后不允许出现零长词。 */
const MIN_WORD_SEC = 0.02;

/** 归一化的对齐单元:一个 CJK 字或一个拉丁/数字字符。 */
interface AlignUnit {
  ch: string;
  /** 所属词(目标侧)或 token(参考侧)的下标。 */
  idx: number;
}

/** 把词/token 流拆成归一化字符单元(小写、去标点空白)。纯函数。 */
export function toAlignUnits(items: Array<{ text: string }>): AlignUnit[] {
  const units: AlignUnit[] = [];
  for (let i = 0; i < items.length; i++) {
    for (const ch of matchingCharacters(items[i].text)) units.push({ ch, idx: i });
  }
  return units;
}

export interface RefineOutcome {
  words: TranscriptWord[];
  /** 目标字符里成功对上参考时间的比例(0..1)。 */
  matchedFrac: number;
  alignedWords: number;
  interpolatedWords: number;
}

/**
 * 用参考 token 流(带可信时间戳)修正目标词表的时间:字符级 LCS 找对应,
 * 命中的词直接采纳参考时间,没命中的词按原相对时长内插进前后锚点之间,
 * 全程保持单调。文本内容原样保留——修的只是时间。纯函数。
 */
export function refineWordTimings(
  words: TranscriptWord[],
  refTokens: TranscriptWord[]
): RefineOutcome {
  if (words.length === 0) return { words: [], matchedFrac: 0, alignedWords: 0, interpolatedWords: 0 };
  const tgt = toAlignUnits(words);
  const ref = toAlignUnits(refTokens);
  if (tgt.length === 0 || ref.length === 0) {
    return { words: [...words], matchedFrac: 0, alignedWords: 0, interpolatedWords: words.length };
  }

  // 标准 LCS 动态规划(候选段字符量级 ~10^3,毫秒级)
  const n = tgt.length;
  const m = ref.length;
  // Bound both allocation and CPU work for pathological imported/edited cues.
  if ((n + 1) * (m + 1) > 4_000_000) return { words: [...words], matchedFrac: 0, alignedWords: 0, interpolatedWords: words.length };
  const dp = new Uint16Array((n + 1) * (m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i * (m + 1) + j] =
        tgt[i - 1].ch === ref[j - 1].ch
          ? dp[(i - 1) * (m + 1) + (j - 1)] + 1
          : Math.max(dp[(i - 1) * (m + 1) + j], dp[i * (m + 1) + (j - 1)]);
    }
  }
  // 回溯出匹配对:目标单元 → 参考 token 下标
  const matchRef = new Int32Array(n).fill(-1);
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (tgt[i - 1].ch === ref[j - 1].ch && dp[i * (m + 1) + j] === dp[(i - 1) * (m + 1) + (j - 1)] + 1) {
      matchRef[i - 1] = ref[j - 1].idx;
      i--;
      j--;
    } else if (dp[(i - 1) * (m + 1) + j] >= dp[i * (m + 1) + (j - 1)]) {
      i--;
    } else {
      j--;
    }
  }

  // 每个词:命中单元的参考 token 时间取 min/max
  const out: Array<TranscriptWord & { matched: boolean }> = words.map((w) => ({ ...w, matched: false }));
  let matchedUnits = 0;
  for (let u = 0; u < n; u++) {
    const rIdx = matchRef[u];
    if (rIdx < 0) continue;
    matchedUnits++;
    const w = out[tgt[u].idx];
    const r = refTokens[rIdx];
    if (!w.matched) {
      w.startSec = r.startSec;
      w.endSec = r.endSec;
      w.matched = true;
    } else {
      w.startSec = Math.min(w.startSec, r.startSec);
      w.endSec = Math.max(w.endSec, r.endSec);
    }
  }

  // 未命中的词:内插进前后锚点之间,按原相对时长分配;两端的用原时长贴锚点
  for (let k = 0; k < out.length; k++) {
    if (out[k].matched) continue;
    // 找未命中连续段 [k, e]
    let e = k;
    while (e + 1 < out.length && !out[e + 1].matched) e++;
    const prev = k > 0 ? out[k - 1] : null;
    const next = e + 1 < out.length ? out[e + 1] : null;
    const origSpan = words[e].endSec - words[k].startSec || MIN_WORD_SEC;
    const from = prev ? prev.endSec : (next ? next.startSec - origSpan : words[k].startSec);
    const to = next ? next.startSec : from + origSpan;
    const scale = Math.max(0, to - from) / origSpan;
    for (let x = k; x <= e; x++) {
      const relStart = words[x].startSec - words[k].startSec;
      const relEnd = words[x].endSec - words[k].startSec;
      out[x].startSec = from + relStart * scale;
      out[x].endSec = Math.max(out[x].startSec + MIN_WORD_SEC, from + relEnd * scale);
    }
    k = e;
  }

  // 单调守卫:对齐/内插的边角误差不允许出现时间倒流
  for (let k = 1; k < out.length; k++) {
    if (out[k].startSec < out[k - 1].endSec - 1e-3) out[k].startSec = out[k - 1].endSec;
    if (out[k].endSec < out[k].startSec + MIN_WORD_SEC) out[k].endSec = out[k].startSec + MIN_WORD_SEC;
  }

  const alignedWords = out.filter((word) => word.matched).length;
  return {
    words: out.map(({ matched, ...word }) => ({
      ...word,
      timingSource: matched ? "aligned" : "interpolated",
    })),
    matchedFrac: matchedUnits / n,
    alignedWords,
    interpolatedWords: out.length - alignedWords,
  };
}

export interface ClipAlignmentResult {
  words: TranscriptWord[];
  report: AlignmentQualityReport;
}

/** 精对齐输入(与 ExportClipSpec 的相关字段同构)。 */
export interface AlignClipInput {
  startSec: number;
  endSec: number;
  pieces?: ClipPiece[];
  words: TranscriptWord[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * 建一个批量精对齐器:模型只 ensure/加载一次,整批切片复用。
 * 返回的 align 对单条切片逐段(拼接片按段)解码并修正词表;
 * 匹配率低于门槛或任何异常返回 null(调用方回退原词表)。
 */
export function createClipAligner(
  modelsRoot: string,
  signal?: AbortSignal
): (filePath: string, clip: AlignClipInput) => Promise<ClipAlignmentResult | null> {
  let recognizer: any = null;
  const ensure = async (): Promise<void> => {
    await ensureModel(modelsRoot, PARAFORMER_MODEL, undefined, signal);
    if (!recognizer) {
      const sh = loadSherpa();
      // 模型文件由原生层自己打开(ANSI):Windows 中文路径先转 8.3 短路径(issue #4)
      const dir = await toAnsiSafeDir(modelDir(modelsRoot, PARAFORMER_MODEL));
      recognizer = new sh.OfflineRecognizer({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          paraformer: { model: join(dir, "model.int8.onnx") },
          tokens: join(dir, "tokens.txt"),
          numThreads: 2,
          provider: "cpu",
          debug: 0,
        },
      });
    }
  };

  /** 解码一个源片区间 → 带绝对时间的 token 流。 */
  const decodeSpan = async (filePath: string, fromSec: number, durationSec: number): Promise<TranscriptWord[]> => {
    const pcmPath = join(tmpdir(), `hotclip-align-${Date.now()}-${Math.round(fromSec * 1000)}.f32le`);
    try {
      await extractPcmF32le16k(resolveFfmpegPath(), filePath, pcmPath, { startSec: fromSec, durationSec }, undefined, signal);
      const samples = await readF32leSamples(pcmPath);
      const sampleRate = 16000;
      const windowSamples = ALIGN_WINDOW_SEC * sampleRate;
      const tokens: TranscriptWord[] = [];
      for (let start = 0; start < samples.length; start += windowSamples) {
        if (signal?.aborted) throw new Error("align cancelled");
        const chunk = samples.subarray(start, Math.min(start + windowSamples, samples.length));
        const stream = recognizer.createStream();
        stream.acceptWaveform({ sampleRate, samples: chunk });
        recognizer.decode(stream);
        const result = recognizer.getResult(stream) as SherpaResult;
        const offsetSec = fromSec + start / sampleRate;
        tokens.push(...tokensToWords(result, offsetSec, offsetSec + chunk.length / sampleRate));
        stream.free?.();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      return tokens;
    } finally {
      await rm(pcmPath, { force: true }).catch(() => {});
    }
  };

  return async (filePath, clip) => {
    signal?.throwIfAborted();
    if (!paraformerSupportsText(clip.words.map((w) => w.text).join(""))) return null;
    await ensure();
    const ranges: Array<{ startSec: number; endSec: number }> =
      clip.pieces && clip.pieces.length > 1 ? clip.pieces : [{ startSec: clip.startSec, endSec: clip.endSec }];
    const refined: TranscriptWord[] = [];
    let matched = 0;
    let total = 0;
    for (const r of ranges) {
      const from = Math.max(0, r.startSec - ALIGN_PAD_SEC);
      const spanDur = r.endSec + ALIGN_PAD_SEC - from;
      const tokens = await decodeSpan(filePath, from, spanDur);
      // 时间戳可用性守卫:若 token 时间几乎不铺开(全挤在一处),说明该
      // 环境/模型档没吐出真时间戳——宁可整条放弃,不能拿假时间改词表
      if (tokens.length >= 5) {
        const spread = tokens[tokens.length - 1].startSec - tokens[0].startSec;
        if (spread < Math.min(spanDur, 5) * 0.2) return null;
      }
      // 词归属按中点判段(与 sliceWords 同一语义)
      const wordsIn = clip.words.filter((w) => {
        const mid = (w.startSec + w.endSec) / 2;
        return mid >= r.startSec && mid <= r.endSec;
      });
      if (wordsIn.length === 0) continue;
      const res = refineWordTimings(wordsIn, tokens);
      const units = toAlignUnits(wordsIn).length;
      matched += res.matchedFrac * units;
      total += units;
      refined.push(...res.words);
    }
    if (total === 0 || matched / total < ALIGN_MIN_MATCH_FRAC) return null;
    const words = refined.sort((a, b) => a.startSec - b.startSec);
    const timing = summarizeTimingQuality(words);
    return {
      words,
      report: {
        matchedFrac: matched / total,
        alignedWords: timing.sourceCounts.aligned ?? 0,
        interpolatedWords: timing.sourceCounts.interpolated ?? 0,
        uncertainSpans: timing.uncertainSpans,
      },
    };
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
