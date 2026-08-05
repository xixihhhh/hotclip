/**
 * 重录(NG)检测:口播录制时说错了重来一遍——同一句话紧挨着说了两遍甚至三遍,
 * 人工剪辑第一件事就是把前面的废稿删掉只留最后一遍。这里用逐句稿的相邻句
 * 相似度找出这些重复,把废稿那几遍变成强制剪切段,复用跳剪的拼接机制。
 *
 * 判据刻意保守——宁可漏剪也不能剪掉有意义的内容:
 *  - 只看紧邻(允许跨一句,重录之间常夹一句"啊不对/等一下");
 *  - 两遍必须挨得近(默认 20 秒内),隔了半小时的同句是话术循环不是重录;
 *  - 太短的句子不碰("好的""对""来"这类天然重复,剪了反而破坏语流);
 *  - 保留最后一遍(说对了才往下讲),剪掉前面的。
 * 纯函数,可单测。
 */
import type { TranscriptWord } from "../shared/api-types";
import { segmentWords } from "./transcribe/segment";
import type { KeptSegment } from "./gaps";

/** 判为同一句的相似度阈值(bigram Dice 系数)。 */
export const RETAKE_SIMILARITY = 0.72;
/** 参与比较的最短句(字符数):短句天然重复,不碰。 */
export const RETAKE_MIN_CHARS = 6;
/** 两遍之间的最大间隔(秒):超过就是话术循环,不是重录。 */
export const RETAKE_MAX_GAP_SEC = 20;
/** 最多允许跨几句去找重录(中间夹"啊不对/等一下"这类插话)。 */
export const RETAKE_LOOKAHEAD = 2;

export interface RetakeHit {
  /** 废稿那一遍的时间段(要剪掉)。 */
  startSec: number;
  endSec: number;
  /** 废稿原文(UI/日志展示"剪掉了什么")。 */
  text: string;
  /** 最终保留的那一遍原文。 */
  keptText: string;
  similarity: number;
}

export interface RetakeOptions {
  similarity?: number;
  minChars?: number;
  maxGapSec?: number;
  lookahead?: number;
}

/**
 * 归一化:去标点空白、转小写。中英文都按「有意义字符序列」比,
 * 免得标点恢复的差异("这款不错" vs "这款不错!")把同一句判成两句。纯函数。
 */
export function normalizeForCompare(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

/** 相邻字符二元组集合(中文按字、英文也按字符——跨语种同一套度量)。 */
function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  if (s.length < 2) {
    if (s.length === 1) out.set(s, 1);
    return out;
  }
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/**
 * Dice 相似度(0-1):2×共有二元组 / 两者二元组总数。
 * 对「说到一半重来」这种前缀重复很敏感,正是重录的典型形态。纯函数。
 */
export function sentenceSimilarity(a: string, b: string): number {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ga = bigrams(na);
  const gb = bigrams(nb);
  let shared = 0;
  let totalA = 0;
  let totalB = 0;
  for (const n of ga.values()) totalA += n;
  for (const [g, n] of gb) {
    totalB += n;
    const inA = ga.get(g);
    if (inA) shared += Math.min(inA, n);
  }
  return totalA + totalB === 0 ? 0 : (2 * shared) / (totalA + totalB);
}

/**
 * 找出重录废稿。输入是一条切片(或整段素材)的逐词稿;内部先折成句子。
 * 一句可能被重录多遍(说错两次),此时前面所有遍都进结果,只留最后一遍。
 */
export function findRetakes(words: TranscriptWord[], options: RetakeOptions = {}): RetakeHit[] {
  const threshold = options.similarity ?? RETAKE_SIMILARITY;
  const minChars = options.minChars ?? RETAKE_MIN_CHARS;
  const maxGapSec = options.maxGapSec ?? RETAKE_MAX_GAP_SEC;
  const lookahead = options.lookahead ?? RETAKE_LOOKAHEAD;
  if (words.length === 0) return [];

  const sentences = segmentWords(words);
  const dropped = new Set<number>();
  const hits: RetakeHit[] = [];

  for (let i = 0; i < sentences.length; i++) {
    if (dropped.has(i)) continue;
    const cur = sentences[i];
    if (normalizeForCompare(cur.text).length < minChars) continue;
    // 往后找最近的一遍重说;找到就把「当前这遍」判为废稿,
    // 然后以后面那遍为基准继续往后找(说错三遍也能连锁剪掉前两遍)
    for (let j = i + 1; j <= Math.min(i + lookahead, sentences.length - 1); j++) {
      if (dropped.has(j)) continue;
      const next = sentences[j];
      if (normalizeForCompare(next.text).length < minChars) continue;
      if (next.startSec - cur.endSec > maxGapSec) break;
      const sim = sentenceSimilarity(cur.text, next.text);
      if (sim >= threshold) {
        dropped.add(i);
        hits.push({
          startSec: cur.startSec,
          endSec: cur.endSec,
          text: cur.text,
          keptText: next.text,
          similarity: Number(sim.toFixed(3)),
        });
        break;
      }
    }
  }
  return hits.sort((a, b) => a.startSec - b.startSec);
}

/** 废稿段 → 强制剪切区间(与 fillerCutSpans 同形,喂给跳剪规划器)。 */
export function retakeCutSpans(hits: RetakeHit[], mergeGapSec = 0.2): KeptSegment[] {
  const sorted = [...hits].sort((a, b) => a.startSec - b.startSec);
  const out: KeptSegment[] = [];
  for (const h of sorted) {
    const last = out[out.length - 1];
    if (last && h.startSec - last.endSec < mergeGapSec) last.endSec = Math.max(last.endSec, h.endSec);
    else out.push({ startSec: h.startSec, endSec: h.endSec });
  }
  return out;
}

/** 落在废稿段里的词要从字幕里去掉(剪掉的内容不能还印在画面上)。 */
export function dropRetakeWords(words: TranscriptWord[], hits: RetakeHit[]): TranscriptWord[] {
  if (hits.length === 0) return words;
  const spans = retakeCutSpans(hits);
  return words.filter((w) => {
    const mid = (w.startSec + w.endSec) / 2;
    return !spans.some((s) => mid >= s.startSec && mid < s.endSec);
  });
}
