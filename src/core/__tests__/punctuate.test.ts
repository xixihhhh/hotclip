import { describe, it, expect } from "vitest";
import { applyPunctuation } from "../transcribe/punctuate";
import type { TranscriptWord } from "../transcribe/types";

function w(text: string, i: number): TranscriptWord {
  return { text, startSec: i, endSec: i + 1 };
}

describe("applyPunctuation", () => {
  it("attaches zh punctuation to the preceding word", () => {
    const words = ["你", "好", "世", "界"].map(w);
    const out = applyPunctuation(words, "你好，世界。");
    expect(out.map((x) => x.text)).toEqual(["你", "好，", "世", "界。"]);
    // timestamps untouched
    expect(out[1].startSec).toBe(1);
  });

  it("skips whitespace and handles latin words case-insensitively", () => {
    const words = ["hello", "world"].map(w);
    const out = applyPunctuation(words, "Hello, world!");
    expect(out.map((x) => x.text)).toEqual(["hello,", "world!"]);
  });

  it("fails open on text mismatch", () => {
    const words = ["你", "好"].map(w);
    const out = applyPunctuation(words, "完全不同的文本。");
    expect(out).toBe(words);
  });

  it("keeps trailing punctuation but rejects trailing letters", () => {
    const words = ["好"].map(w);
    expect(applyPunctuation(words, "好。")[0].text).toBe("好。");
    expect(applyPunctuation(words, "好啊")).toBe(words);
  });
});
