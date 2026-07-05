import { describe, expect, it } from "vitest";
import { assignWordSpeakers, speakerCount, type SpeakerTurn } from "../diarize";
import type { TranscriptWord } from "../../shared/api-types";

const w = (text: string, s: number, e: number): TranscriptWord => ({ text, startSec: s, endSec: e });

describe("assignWordSpeakers", () => {
  const turns: SpeakerTurn[] = [
    { startSec: 0, endSec: 3, speaker: 0 },
    { startSec: 3.4, endSec: 6, speaker: 1 },
  ];

  it("labels words by maximum overlap", () => {
    const out = assignWordSpeakers([w("甲", 0.5, 1.0), w("乙", 4.0, 4.5)], turns);
    expect(out[0].speaker).toBe(0);
    expect(out[1].speaker).toBe(1);
  });

  it("a word straddling a turn change goes to the side covering more of it", () => {
    const out = assignWordSpeakers([w("跨", 2.8, 3.6)], turns);
    expect(out[0].speaker).toBe(0); // 0.2s with A vs 0.2s with B — tie keeps first max; adjust span
    const out2 = assignWordSpeakers([w("跨", 2.9, 3.8)], turns);
    expect(out2[0].speaker).toBe(1); // 0.1s vs 0.4s
  });

  it("gap words adopt the nearest turn only within the tolerance", () => {
    const out = assignWordSpeakers([w("近", 3.15, 3.35), w("远", 8.0, 8.4)], turns);
    expect(out[0].speaker).toBe(1); // 0.05s from turn B vs 0.15s from turn A
    expect(out[1].speaker).toBeUndefined(); // 2s past the last turn
  });

  it("no turns → words pass through untouched", () => {
    const words = [w("原", 0, 1)];
    expect(assignWordSpeakers(words, [])).toBe(words);
  });
});

describe("speakerCount", () => {
  it("counts distinct ids", () => {
    expect(speakerCount([
      { startSec: 0, endSec: 1, speaker: 0 },
      { startSec: 1, endSec: 2, speaker: 1 },
      { startSec: 2, endSec: 3, speaker: 0 },
    ])).toBe(2);
  });
});
