import { describe, it, expect } from "vitest";
import { alignmentLanguage, previewTranscriptAlignment } from "../transcript-alignment";
import { rebuildWords } from "../../shared/edit-transcript";
import { refineWordTimings } from "../align";
import type { Transcript } from "../../shared/api-types";

const segment = { id: 1, startSec: 0, endSec: 2, text: "hello world", words: rebuildWords("hello world", 0, 2) };
const transcript: Transcript = { engine: "subtitle-srt", language: "en", durationSec: 3, segments: [segment] };
describe("review-time alignment", () => {
  it("returns a preview preserving text, cue bounds and the original transcript", async () => {
    const before = JSON.stringify(transcript);
    const result = await previewTranscriptAlignment("unused", transcript, { segmentIds: [1], engine: "paraformer" }, "unused", undefined,
      async (s) => s.words.map((w) => ({ ...w, timingSource: "aligned" })));
    expect(result.alignedWords).toBe(2);
    expect(result.segments[0].text).toBe(segment.text);
    expect(JSON.stringify(transcript)).toBe(before);
  });
  it("does not run the Chinese/English model for unsupported scripts", async () => {
    let calls = 0;
    const value = { ...transcript, language: "ru", segments: [{ ...segment, text: "Привет", words: rebuildWords("Привет", 0, 2) }] };
    const result = await previewTranscriptAlignment("unused", value, { segmentIds: [1], engine: "paraformer" }, "unused", undefined, async () => { calls++; return []; });
    expect(calls).toBe(0);
    expect(result.skipped[0].reason).toBe("unsupported-language");
    expect(alignmentLanguage("French", "Bonjour")).toBe("fr");
  });
  it("retains original words on bad/overlapping timing and oversized requests", async () => {
    const result = await previewTranscriptAlignment("unused", transcript, { segmentIds: [1], engine: "paraformer" }, "unused", undefined,
      async (s) => s.words.map((w) => ({ ...w, startSec: 1.9, endSec: 9 })));
    expect(result.segments).toEqual([]);
    expect(result.skipped[0].reason).toBe("invalid-timing");
    await expect(previewTranscriptAlignment("unused", transcript, { segmentIds: [1, 2], engine: "paraformer" }, "unused")).rejects.toThrow("batch-limit");
  });
  it("normalizes multilingual matching and rejects unbounded LCS work", () => {
    const words = rebuildWords("café Привет مرحبا", 0, 3);
    expect(refineWordTimings(words, words).matchedFrac).toBe(1);
    const huge = rebuildWords("x".repeat(3000), 0, 3);
    expect(refineWordTimings(huge, huge).matchedFrac).toBe(0);
  });
});
