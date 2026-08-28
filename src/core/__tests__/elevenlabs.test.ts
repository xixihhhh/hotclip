import { describe, it, expect } from "vitest";
import { parseScribeWords } from "../transcribe/elevenlabs";

describe("parseScribeWords", () => {
  it("maps words, drops spacing tokens and malformed entries", () => {
    const words = parseScribeWords({
      language_code: "zh",
      words: [
        { text: "你好", start: 0.1, end: 0.5, type: "word" },
        { text: " ", start: 0.5, end: 0.6, type: "spacing" },
        { text: "世界", start: 0.6, end: 1.0, type: "word" },
        { text: "坏的", type: "word" }, // no timestamps
        { text: "", start: 1, end: 2, type: "word" }, // empty
      ],
    });
    expect(words).toEqual([
      { text: "你好", startSec: 0.1, endSec: 0.5, timingSource: "native" },
      { text: "世界", startSec: 0.6, endSec: 1.0, timingSource: "native" },
    ]);
  });

  it("clamps inverted end times and handles missing words array", () => {
    expect(parseScribeWords({})).toEqual([]);
    const [w] = parseScribeWords({ words: [{ text: "a", start: 2, end: 1 }] });
    expect(w.endSec).toBe(2);
  });
});
