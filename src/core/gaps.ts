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

export interface KeptSegment {
  /** Absolute source time. */
  startSec: number;
  endSec: number;
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
/** Breathing room kept around speech on both sides of a cut. */
const PAD_BEFORE_SEC = 0.12;
const PAD_AFTER_SEC = 0.18;
/** Lead-in / tail padding at the clip boundaries. */
const LEAD_IN_SEC = 0.15;
const TAIL_SEC = 0.3;

export function computeJumpCut(
  words: TranscriptWord[],
  clipStartSec: number,
  clipEndSec: number
): JumpCutPlan {
  const inClip = words.filter((w) => w.endSec > clipStartSec && w.startSec < clipEndSec);
  if (inClip.length === 0) {
    const full = { startSec: clipStartSec, endSec: clipEndSec };
    return { segments: [full], words: [], breaks: [], removedSec: 0, durationSec: clipEndSec - clipStartSec };
  }

  const segments: KeptSegment[] = [];
  let segStart = Math.max(clipStartSec, inClip[0].startSec - LEAD_IN_SEC);
  let prevEnd = inClip[0].endSec;
  for (let i = 1; i < inClip.length; i++) {
    const w = inClip[i];
    const gap = w.startSec - prevEnd;
    if (gap > GAP_THRESHOLD_SEC) {
      segments.push({ startSec: segStart, endSec: Math.min(prevEnd + PAD_AFTER_SEC, clipEndSec) });
      segStart = Math.max(w.startSec - PAD_BEFORE_SEC, prevEnd + PAD_AFTER_SEC);
    }
    prevEnd = Math.max(prevEnd, w.endSec);
  }
  segments.push({ startSec: segStart, endSec: Math.min(prevEnd + TAIL_SEC, clipEndSec) });

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
        });
      }
    }
    outOffset += seg.endSec - seg.startSec;
  }
  return { segments, words: remapped, breaks, removedSec, durationSec };
}
