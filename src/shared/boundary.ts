/**
 * Sentence-step boundary adjustment for highlight clips: extend/shrink either
 * edge by whole transcript sentences (word-accurate boundaries come free —
 * segments are built from word timestamps). Pure & platform-neutral so both
 * the renderer (interactive tweaking) and core can use it.
 */
import type { Transcript, TranscriptSegment } from "./api-types";

const EPS = 1e-3;
/** Manual tweaking is allowed a wider range than auto-detection. */
const MIN_SEC = 3;
const MAX_SEC = 120;

function overlapping(transcript: Transcript, startSec: number, endSec: number): TranscriptSegment[] {
  return transcript.segments.filter((s) => s.endSec > startSec + EPS && s.startSec < endSec - EPS);
}

export interface AdjustedBoundary {
  startSec: number;
  endSec: number;
  text: string;
}

/**
 * Move one clip edge by one sentence. `dir` follows the timeline:
 *  - start edge: -1 pulls the previous sentence in, +1 drops the first one
 *  - end edge:   +1 pulls the next sentence in,     -1 drops the last one
 * Returns null when the move is impossible (no neighbour, would collapse,
 * or leaves the duration outside sane bounds).
 */
export function adjustClipBoundary(
  transcript: Transcript,
  clip: { startSec: number; endSec: number },
  edge: "start" | "end",
  dir: 1 | -1
): AdjustedBoundary | null {
  const segs = transcript.segments;
  const inside = overlapping(transcript, clip.startSec, clip.endSec);
  if (inside.length === 0) return null;

  let startSec = clip.startSec;
  let endSec = clip.endSec;

  if (edge === "start") {
    const firstIdx = segs.findIndex((s) => s.id === inside[0].id);
    if (dir === -1) {
      if (firstIdx <= 0) return null;
      startSec = segs[firstIdx - 1].startSec;
    } else {
      if (inside.length < 2) return null;
      startSec = inside[1].startSec;
    }
  } else {
    const lastIdx = segs.findIndex((s) => s.id === inside[inside.length - 1].id);
    if (dir === 1) {
      if (lastIdx < 0 || lastIdx + 1 >= segs.length) return null;
      endSec = segs[lastIdx + 1].endSec;
    } else {
      if (inside.length < 2) return null;
      endSec = inside[inside.length - 2].endSec;
    }
  }

  const dur = endSec - startSec;
  if (dur < MIN_SEC || dur > MAX_SEC) return null;
  const text = overlapping(transcript, startSec, endSec)
    .map((s) => s.text)
    .join(" ");
  return { startSec, endSec, text };
}
