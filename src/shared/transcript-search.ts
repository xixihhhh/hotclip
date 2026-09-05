import type { TranscriptSegment } from "./api-types";
import { matchingCharacters } from "./speech-text";

export interface TranscriptSearchHit {
  segmentIds: number[];
  startSec: number;
  ranges: Array<{ segmentId: number; start: number; end: number }>;
}
interface SearchRef { segmentId: number; start: number; end: number; startSec: number }
export interface TranscriptSearchIndex { text: string; refs: SearchRef[] }

/** Normalize punctuation, spacing, case and compatibility forms for cross-cue
 * matching while retaining original UTF-16 positions for safe React marks. */
export function indexTranscript(segments: readonly TranscriptSegment[]): TranscriptSearchIndex {
  const text: string[] = [];
  const refs: SearchRef[] = [];
  const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const segment of segments) {
    for (const part of graphemes.segment(segment.text)) {
      for (const ch of matchingCharacters(part.segment)) {
        text.push(ch);
        // String#indexOf uses UTF-16 offsets, including astral CJK characters.
        for (let j = 0; j < ch.length; j++) refs.push({ segmentId: segment.id, start: part.index, end: part.index + part.segment.length, startSec: segment.startSec });
      }
    }
  }
  return { text: text.join(""), refs };
}

export function searchTranscript(index: TranscriptSearchIndex, query: string, limit = 2000): TranscriptSearchHit[] {
  const needle = matchingCharacters(query.slice(0, 500)).join("");
  if (!needle) return [];
  const hits: TranscriptSearchHit[] = [];
  let from = 0;
  while (hits.length < limit) {
    const at = index.text.indexOf(needle, from);
    if (at < 0) break;
    const ranges: TranscriptSearchHit["ranges"] = [];
    for (let i = at; i < at + needle.length; i++) {
      const ref = index.refs[i];
      const last = ranges[ranges.length - 1];
      if (last?.segmentId === ref.segmentId) last.end = ref.end;
      else ranges.push({ segmentId: ref.segmentId, start: ref.start, end: ref.end });
    }
    hits.push({ ranges, segmentIds: ranges.map((r) => r.segmentId), startSec: index.refs[at].startSec });
    from = at + Math.max(1, needle.length);
  }
  return hits;
}
