import { describe, expect, it } from "vitest";
import { indexTranscript, searchTranscript } from "../transcript-search";
import { rebuildWords } from "../edit-transcript";

function segments(texts: string[]) { return texts.map((text, i) => ({ id: i + 1, text, startSec: i * 5, endSec: i * 5 + 4, words: rebuildWords(text, i * 5, i * 5 + 4) })); }
describe("transcript search", () => {
  it("matches phrases across cue boundaries and maps marks to original text", () => {
    const index = indexTranscript(segments(["Hello,", "world!", "Another WORLD"]));
    expect(searchTranscript(index, "hello world")[0]).toEqual({ segmentIds: [1, 2], startSec: 0, ranges: [{ segmentId: 1, start: 0, end: 5 }, { segmentId: 2, start: 0, end: 5 }] });
    expect(searchTranscript(index, "world")).toHaveLength(2);
  });
  it("supports compatibility forms, composed accents, Arabic, Cyrillic and astral Han", () => {
    for (const [source, query] of [["Ｃａｆｅ́", "café"], ["Привет мир", "ПРИВЕТ"], ["مرحبا بالعالم", "مرحبا"], ["𠀀你好", "𠀀你"]]) {
      const match = searchTranscript(indexTranscript(segments([source])), query)[0];
      expect(match).toBeDefined();
      expect(match.ranges[0].end).toBeLessThanOrEqual(source.length);
    }
  });
  it("handles punctuation-only queries and caps huge result sets", () => {
    const index = indexTranscript(segments(Array(2100).fill("match")));
    expect(searchTranscript(index, "???")).toEqual([]);
    expect(searchTranscript(index, "match")).toHaveLength(2000);
  });
});
