import { describe, it, expect } from "vitest";
import { segmentWords, joinWords } from "../transcribe/segment";
import { tokensToWords } from "../transcribe/sensevoice";
import { candidateUrls, SENSEVOICE_MODEL } from "../models";
import type { TranscriptWord } from "../transcribe/types";

const w = (text: string, startSec: number, endSec: number): TranscriptWord => ({ text, startSec, endSec });

describe("joinWords", () => {
  it("CJK concatenates without spaces", () => {
    expect(joinWords([w("今", 0, 0.2), w("天", 0.2, 0.4), w("好", 0.4, 0.6)])).toBe("今天好");
  });

  it("latin joins with spaces and tucks punctuation", () => {
    expect(joinWords([w("hello", 0, 0.3), w("world", 0.3, 0.6), w(",", 0.6, 0.7), w("hi", 0.7, 1)])).toBe(
      "hello world, hi"
    );
  });
});

describe("segmentWords", () => {
  it("splits on hard sentence punctuation", () => {
    const segs = segmentWords([w("你好。", 0, 0.5), w("再", 0.6, 0.8), w("见", 0.8, 1.0)]);
    expect(segs).toHaveLength(2);
    expect(segs[0].text).toBe("你好。");
    expect(segs[1].text).toBe("再见");
    expect(segs[1].startSec).toBeCloseTo(0.6, 3);
  });

  it("splits on silence gaps without punctuation", () => {
    const segs = segmentWords([w("第一段", 0, 1), w("第二段", 2.5, 3.5)], { gapSec: 0.8 });
    expect(segs).toHaveLength(2);
  });

  it("run-on guard splits long punctuation-less speech", () => {
    const words: TranscriptWord[] = [];
    for (let i = 0; i < 100; i++) words.push(w(`词${i}`, i * 0.3, i * 0.3 + 0.3));
    const segs = segmentWords(words, { maxSec: 12 });
    expect(segs.length).toBeGreaterThan(1);
    for (const s of segs) expect(s.endSec - s.startSec).toBeLessThanOrEqual(13);
  });

  it("skips empty/whitespace tokens and returns ordered ids", () => {
    const segs = segmentWords([w(" ", 0, 0.1), w("好。", 0.1, 0.4), w("嗯。", 0.5, 0.8)]);
    expect(segs.map((s) => s.id)).toEqual([1, 2]);
  });
});

describe("tokensToWords", () => {
  it("offsets timestamps and derives ends from next start", () => {
    const words = tokensToWords(
      { text: "ab", tokens: ["a", "b"], timestamps: [0.5, 1.0] },
      10,
      12
    );
    expect(words).toHaveLength(2);
    expect(words[0]).toEqual({ text: "a", startSec: 10.5, endSec: 11.0, timingSource: "native" });
    expect(words[1].startSec).toBe(11.0);
    expect(words[1].endSec).toBeLessThanOrEqual(12);
  });

  it("tolerates missing timestamps/tokens", () => {
    expect(tokensToWords({ text: "x" }, 0, 1)).toEqual([]);
    const estimated = tokensToWords({ text: "x", tokens: ["x"], timestamps: [] }, 0, 1)[0];
    expect(estimated.startSec).toBe(0);
    expect(estimated.timingSource).toBe("estimated");
  });
});

describe("candidateUrls", () => {
  it("tries mirrors before origin (domestic-first)", () => {
    const urls = candidateUrls(SENSEVOICE_MODEL);
    expect(urls.length).toBe(SENSEVOICE_MODEL.mirrors.length + 1);
    expect(urls[urls.length - 1]).toBe(SENSEVOICE_MODEL.url);
    expect(urls[0].startsWith(SENSEVOICE_MODEL.mirrors[0])).toBe(true);
    expect(urls[0]).toContain("github.com");
  });
});
