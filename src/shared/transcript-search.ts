import type { TranscriptSegment } from "./api-types";
import { matchingCharacters } from "./speech-text";
import { isUncertainTiming } from "./transcript-quality";

export type SearchTiming = "word" | "estimated" | "segment";

export interface TranscriptSearchHit {
  match: "exact" | "approximate";
  segmentIds: number[];
  startSec: number;
  endSec: number;
  timing: SearchTiming;
  ranges: Array<{ segmentId: number; start: number; end: number }>;
}
interface SearchRef { segmentId: number; start: number; end: number; startSec: number; endSec: number; timing: SearchTiming }
export interface TranscriptSearchIndex { text: string; refs: SearchRef[] }

const MAX_QUERY_LENGTH = 32;

/** Short queries produce too many unrelated near matches; long ones cost too much to scan. */
export function canSearchSimilarTranscript(query: string): boolean {
  const length = matchingCharacters(query).length;
  return length >= 4 && length <= MAX_QUERY_LENGTH;
}

/** 只有全文与词序一致、时间合法时才采用词级定位；纠错后的旧词序不可复用。 */
function timedCharacters(segment: TranscriptSegment): Array<{ startSec: number; endSec: number; timing: SearchTiming }> | null {
  const refs: Array<{ startSec: number; endSec: number; timing: SearchTiming }> = [];
  let text = "";
  let previousEnd = segment.startSec;
  for (const word of segment.words) {
    if (!Number.isFinite(word.startSec) || !Number.isFinite(word.endSec) ||
        word.startSec < previousEnd || word.endSec <= word.startSec || word.endSec > segment.endSec) return null;
    previousEnd = word.endSec;
    const normalized = matchingCharacters(word.text).join("");
    text += normalized;
    for (let i = 0; i < normalized.length; i++) refs.push({
      startSec: word.startSec, endSec: word.endSec,
      timing: isUncertainTiming(word) ? "estimated" : "word",
    });
  }
  return text === matchingCharacters(segment.text).join("") ? refs : null;
}

/** Normalize punctuation, spacing, case and compatibility forms for cross-cue
 * matching while retaining original UTF-16 positions for safe React marks. */
export function indexTranscript(segments: readonly TranscriptSegment[]): TranscriptSearchIndex {
  const text: string[] = [];
  const refs: SearchRef[] = [];
  const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const segment of segments) {
    const times = timedCharacters(segment);
    let offset = 0;
    for (const part of graphemes.segment(segment.text)) {
      for (const ch of matchingCharacters(part.segment)) {
        text.push(ch);
        // String#indexOf uses UTF-16 offsets, including astral CJK characters.
        for (let j = 0; j < ch.length; j++) refs.push({
          segmentId: segment.id, start: part.index, end: part.index + part.segment.length,
          ...(times?.[offset++] ?? { startSec: segment.startSec, endSec: segment.endSec, timing: "segment" as const }),
        });
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
    hits.push(hitFromRefs(index.refs, at, at + needle.length, "exact"));
    from = at + Math.max(1, needle.length);
  }
  return hits;
}

function hitFromRefs(refs: SearchRef[], start: number, end: number, match: TranscriptSearchHit["match"]): TranscriptSearchHit {
  const ranges: TranscriptSearchHit["ranges"] = [];
  for (let i = start; i < end; i++) {
    const ref = refs[i];
    const last = ranges[ranges.length - 1];
    if (last?.segmentId === ref.segmentId) last.end = ref.end;
    else ranges.push({ segmentId: ref.segmentId, start: ref.start, end: ref.end });
  }
  const matched = refs.slice(start, end);
  const timing: SearchTiming = matched.some((ref) => ref.timing === "segment") ? "segment"
    : matched.some((ref) => ref.timing === "estimated") ? "estimated" : "word";
  return { match, ranges, segmentIds: ranges.map((r) => r.segmentId), startSec: matched[0].startSec, endSec: matched[matched.length - 1].endSec, timing };
}

function oneEditApart(needle: string[], haystack: string[], start: number, length: number): boolean {
  let i = 0;
  let j = start;
  let edits = 0;
  const end = start + length;
  while (i < needle.length && j < end) {
    if (needle[i] === haystack[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (needle.length > length) i++;
    else if (needle.length < length) j++;
    else { i++; j++; }
  }
  return edits + (needle.length - i) + (end - j) === 1;
}

/** Optional, bounded one-character edit search; never changes transcript text or timing. */
export function searchSimilarTranscript(index: TranscriptSearchIndex, query: string, limit = 200): TranscriptSearchHit[] {
  if (!canSearchSimilarTranscript(query) || limit <= 0) return [];
  const needle = matchingCharacters(query);
  const haystack = Array.from(index.text);
  const offsets: number[] = [];
  let utf16Offset = 0;
  for (const ch of haystack) { offsets.push(utf16Offset); utf16Offset += ch.length; }
  offsets.push(utf16Offset);
  const hits: TranscriptSearchHit[] = [];
  let previousEnd = 0;
  for (let start = 0; start < haystack.length && hits.length < limit; start++) {
    if (start < previousEnd) continue;
    // Same-length substitutions first; insertion/deletion variants share a location.
    for (const length of [needle.length, needle.length - 1, needle.length + 1]) {
      if (start + length > haystack.length || !oneEditApart(needle, haystack, start, length)) continue;
      hits.push(hitFromRefs(index.refs, offsets[start], offsets[start + length], "approximate"));
      previousEnd = start + length;
      break;
    }
  }
  return hits;
}
