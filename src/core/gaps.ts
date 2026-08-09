/**
 * Jump-cut planning: remove intra-clip silences so exported clips have the
 * tight rhythm of a human edit instead of the slack of a machine cut.
 *
 * Input: the clip's words (absolute source time). Silence = the gap between
 * consecutive words above a threshold. Output: the kept source segments plus
 * the same words remapped onto the compressed output timeline (for captions).
 * Pure functions — ffmpeg execution lives in cut.ts.
 */
import type { TranscriptWord } from "../shared/api-types";
import { peakInRange, type PeakTrack } from "./audio-peaks";

export interface KeptSegment {
  /** Absolute source time. */
  startSec: number;
  endSec: number;
}

export interface JumpCutOptions {
  /**
   * Audio peak track for the clip. When present, a word gap is only cut if
   * the region that would be removed is actually quiet — laughter, applause
   * and BGM stings carry no words but must survive.
   */
  peaks?: PeakTrack;
  /** Peak (0..1) above which a gap counts as "not silent" (~-28dBFS). */
  silenceThreshold?: number;
  /**
   * Spans that must be cut regardless of gaps or loudness — filler words and
   * stutters are audible speech, so neither the gap rule nor the silence gate
   * would ever remove them on their own.
   */
  forceCutSpans?: KeptSegment[];
  /** Word-gap cut threshold; pass Infinity to disable gap cuts entirely. */
  gapThresholdSec?: number;
  /**
   * 禁删区间(绝对源时间):情绪事件(笑声/怒吼/掌声峰)前后的停顿是节目
   * 效果——抖包袱前的憋、爆发后的余韵——删掉它们等于删掉喜剧节奏。
   * 待删空隙与任一禁删区间相交时,这个 gap 不剪(仅约束 gap 剪,不影响
   * forceCutSpans——语气词/重录/拼接是明确要删的内容)。
   */
  protectedSpans?: KeptSegment[];
  /**
   * 保留呼吸口(v0.14):每个 gap 剪口在语音尾部多留这么多秒的自然停顿——
   * 长停顿照剪,但剪完不是无缝贴死,句间还有一口气。跳剪「过瘦」是 AI 味
   * 的来源之一(真人剪辑会给呼吸留空)。0/缺省 = 历史紧凑节奏不变。
   */
  breathPadSec?: number;
}

/** Subtract cut spans from kept segments (interval difference). Pure. */
export function subtractSpans(segments: KeptSegment[], spans: KeptSegment[], minKeepSec = 0.12): KeptSegment[] {
  if (spans.length === 0) return segments;
  const out: KeptSegment[] = [];
  for (const seg of segments) {
    let pieces: KeptSegment[] = [{ ...seg }];
    for (const span of spans) {
      const next: KeptSegment[] = [];
      for (const p of pieces) {
        if (span.endSec <= p.startSec || span.startSec >= p.endSec) {
          next.push(p);
          continue;
        }
        if (span.startSec > p.startSec) next.push({ startSec: p.startSec, endSec: span.startSec });
        if (span.endSec < p.endSec) next.push({ startSec: span.endSec, endSec: p.endSec });
      }
      pieces = next;
    }
    out.push(...pieces.filter((p) => p.endSec - p.startSec >= minKeepSec));
  }
  return out;
}

export interface JumpCutPlan {
  segments: KeptSegment[];
  /** Words shifted onto the output timeline (t=0 at clip start). */
  words: TranscriptWord[];
  /**
   * Output-time positions where a splice happened (segment 2+ starts).
   * Caption line breaking must break here — the silence that used to separate
   * these sentences no longer exists on the compressed timeline.
   */
  breaks: number[];
  /** Total seconds removed. */
  removedSec: number;
  /** Output duration (sum of kept segments). */
  durationSec: number;
}

/** Word gaps longer than this get cut. */
const GAP_THRESHOLD_SEC = 0.6;
/** 「保留呼吸口」的默认留白量(加在语音尾部 PAD_AFTER 之上)。 */
export const BREATH_PAD_SEC = 0.25;
/** Breathing room kept around speech on both sides of a cut. */
const PAD_BEFORE_SEC = 0.12;
const PAD_AFTER_SEC = 0.18;
/** Lead-in / tail padding at the clip boundaries. */
const LEAD_IN_SEC = 0.15;
const TAIL_SEC = 0.3;
/** Default peak above which a gap is loud enough to keep (~-28dBFS). */
const SILENCE_PEAK_THRESHOLD = 0.04;
/** Splices removing less than this are churn, not rhythm — fill them back. */
const MIN_CUT_SEC = 0.2;

/** Merge kept segments whose separating cut is too short to be worth a splice. */
export function mergeShortCuts(segments: KeptSegment[], minCutSec = MIN_CUT_SEC): KeptSegment[] {
  if (segments.length < 2) return segments;
  const out: KeptSegment[] = [{ ...segments[0] }];
  for (let i = 1; i < segments.length; i++) {
    const prev = out[out.length - 1];
    if (segments[i].startSec - prev.endSec < minCutSec) {
      prev.endSec = Math.max(prev.endSec, segments[i].endSec);
    } else {
      out.push({ ...segments[i] });
    }
  }
  return out;
}

export function computeJumpCut(
  words: TranscriptWord[],
  clipStartSec: number,
  clipEndSec: number,
  options: JumpCutOptions = {}
): JumpCutPlan {
  const { peaks, silenceThreshold = SILENCE_PEAK_THRESHOLD, forceCutSpans = [], gapThresholdSec = GAP_THRESHOLD_SEC, protectedSpans = [], breathPadSec = 0 } = options;
  // 呼吸口加在语音尾部:剪掉的区间相应缩短,句尾多留一口气
  const padAfter = PAD_AFTER_SEC + Math.max(0, breathPadSec);
  const inClip = words.filter((w) => w.endSec > clipStartSec && w.startSec < clipEndSec);
  if (inClip.length === 0) {
    const full = { startSec: clipStartSec, endSec: clipEndSec };
    return { segments: [full], words: [], breaks: [], removedSec: 0, durationSec: clipEndSec - clipStartSec };
  }

  let segments: KeptSegment[] = [];
  let segStart = Math.max(clipStartSec, inClip[0].startSec - LEAD_IN_SEC);
  let prevEnd = inClip[0].endSec;
  for (let i = 1; i < inClip.length; i++) {
    const w = inClip[i];
    const gap = w.startSec - prevEnd;
    if (gap > gapThresholdSec) {
      // AND gate: the removed span must be word-free AND acoustically quiet.
      const removedFrom = prevEnd + padAfter;
      const removedTo = w.startSec - PAD_BEFORE_SEC;
      const quiet =
        !peaks || removedTo <= removedFrom || peakInRange(peaks, removedFrom, removedTo) < silenceThreshold;
      // 情绪守卫:待删空隙撞上禁删区间(情绪事件 ±保护半径)就不剪
      const protectedGap = protectedSpans.some((p) => p.startSec < removedTo && p.endSec > removedFrom);
      if (quiet && !protectedGap) {
        segments.push({ startSec: segStart, endSec: Math.min(prevEnd + padAfter, clipEndSec) });
        segStart = Math.max(w.startSec - PAD_BEFORE_SEC, prevEnd + padAfter);
      }
    }
    prevEnd = Math.max(prevEnd, w.endSec);
  }
  segments.push({ startSec: segStart, endSec: Math.min(prevEnd + TAIL_SEC, clipEndSec) });
  // merge first, subtract after — a forced cut (filler ≈0.15s) must never be
  // "filled back" by the short-cut smoothing pass
  segments = mergeShortCuts(segments);
  segments = subtractSpans(segments, forceCutSpans);

  const durationSec = segments.reduce((acc, s) => acc + (s.endSec - s.startSec), 0);
  const removedSec = clipEndSec - clipStartSec - durationSec;

  // Remap words onto the compressed output timeline.
  const remapped: TranscriptWord[] = [];
  const breaks: number[] = [];
  let outOffset = 0;
  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];
    if (si > 0) breaks.push(outOffset);
    for (const w of inClip) {
      if (w.startSec >= seg.startSec - 1e-6 && w.startSec < seg.endSec) {
        remapped.push({
          text: w.text,
          startSec: outOffset + (w.startSec - seg.startSec),
          endSec: outOffset + Math.min(w.endSec, seg.endSec) - seg.startSec,
          // 说话人标注跟着词走——丢了它,压缩时间轴上的字幕就没法按人上色/打标签
          ...(w.speaker !== undefined ? { speaker: w.speaker } : {}),
        });
      }
    }
    outOffset += seg.endSec - seg.startSec;
  }
  return { segments, words: remapped, breaks, removedSec, durationSec };
}
