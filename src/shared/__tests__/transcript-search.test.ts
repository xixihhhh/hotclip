import { describe, expect, it } from "vitest";
import { canSearchSimilarTranscript, indexTranscript, searchSimilarTranscript, searchTranscript } from "../transcript-search";
import { rebuildWords } from "../edit-transcript";

function segments(texts: string[]) { return texts.map((text, i) => ({ id: i + 1, text, startSec: i * 5, endSec: i * 5 + 4, words: rebuildWords(text, i * 5, i * 5 + 4) })); }
describe("transcript search", () => {
  it("matches phrases across cue boundaries and maps marks to original text", () => {
    const index = indexTranscript(segments(["Hello,", "world!", "Another WORLD"]));
    expect(searchTranscript(index, "hello world")[0]).toMatchObject({ segmentIds: [1, 2], startSec: 0, timing: "estimated", ranges: [{ segmentId: 1, start: 0, end: 5 }, { segmentId: 2, start: 0, end: 5 }] });
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
  it("locates a late word instead of rewinding to the start of the sentence", () => {
    const segment = { id: 7, text: "Hello, WORLD!", startSec: 10, endSec: 20, words: [
      { text: "Hello", startSec: 11, endSec: 12, timingSource: "native" as const },
      { text: "world", startSec: 17, endSec: 18, timingSource: "aligned" as const },
    ] };
    expect(searchTranscript(indexTranscript([segment]), "world")[0]).toMatchObject({ startSec: 17, endSec: 18, timing: "word" });
  });
  it("retains uncertain provenance instead of presenting edited word times as exact", () => {
    expect(searchTranscript(indexTranscript(segments(["hello world"])), "world")[0]).toMatchObject({ timing: "estimated" });
  });
  it("falls back to sentence bounds for stale text or malformed word timing", () => {
    const segment = { id: 1, text: "hello world", startSec: 2, endSec: 8, words: [
      { text: "hello", startSec: 3, endSec: 4 }, { text: "world", startSec: 6, endSec: 7 },
    ] };
    for (const words of [[], [{ text: "stale", startSec: 3, endSec: 4 }],
      [segment.words[0], { ...segment.words[1], startSec: NaN }],
      [segment.words[0], { ...segment.words[1], startSec: 3.5 }],
      [segment.words[0], { ...segment.words[1], endSec: 9 }]]) {
      expect(searchTranscript(indexTranscript([{ ...segment, words }]), "world")[0]).toMatchObject({ startSec: 2, endSec: 8, timing: "segment" });
    }
  });
  it("keeps UTF-16 text positions aligned with Unicode word timestamps", () => {
    const segment = { id: 1, text: "Ｃａｆｅ́，𠀀你好", startSec: 0, endSec: 10, words: [
      { text: "Café", startSec: 1, endSec: 2 },
      { text: "𠀀", startSec: 5, endSec: 6 },
      { text: "你好", startSec: 7, endSec: 8 },
    ] };
    const hit = searchTranscript(indexTranscript([segment]), "𠀀你")[0];
    expect(hit).toMatchObject({ startSec: 5, endSec: 8, timing: "word" });
    expect(segment.text.slice(hit.ranges[0].start, hit.ranges[0].end)).toBe("𠀀你");
    expect(searchTranscript(indexTranscript([segment]), "你好")[0]).toMatchObject({ startSec: 7, endSec: 8 });
  });
  it("finds one-character substitutions, omissions and additions only when requested", () => {
    const index = indexTranscript(segments(["今天介绍新产品", "欢迎大家来观看"]));
    expect(searchTranscript(index, "今天介绍鑫产品")).toEqual([]);
    for (const query of ["今天介绍鑫产品", "今天介新产品", "今天介绍新新产品"]) {
      expect(searchSimilarTranscript(index, query)[0]).toMatchObject({ match: "approximate", segmentIds: [1], timing: "estimated" });
    }
    expect(searchSimilarTranscript(index, "今天完全不同")).toEqual([]);
    expect(searchSimilarTranscript(index, "新产")).toEqual([]);
    expect(canSearchSimilarTranscript("新产")).toBe(false);
    expect(canSearchSimilarTranscript("a".repeat(33))).toBe(false);
  });
  it("keeps Unicode marks and timing on the original near-matched phrase", () => {
    const segment = { id: 3, text: "𠀀你好啊", startSec: 0, endSec: 5, words: [
      { text: "𠀀", startSec: 0.5, endSec: 1 },
      { text: "你", startSec: 1, endSec: 2 },
      { text: "好", startSec: 2, endSec: 3 },
      { text: "啊", startSec: 3, endSec: 4 },
    ] };
    const hit = searchSimilarTranscript(indexTranscript([segment]), "𠀀你坏啊")[0];
    expect(hit).toMatchObject({ startSec: 0.5, endSec: 4, timing: "word", match: "approximate" });
    expect(segment.text.slice(hit.ranges[0].start, hit.ranges[0].end)).toBe("𠀀你好啊");
  });
});
