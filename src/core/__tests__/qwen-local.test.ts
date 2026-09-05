import { afterEach, describe, expect, it, vi } from "vitest";
import { localSpeechUrl, parseQwenWords, qwenHealth, qwenTranscriptWords } from "../transcribe/qwen-local";
afterEach(() => vi.unstubAllGlobals());
describe("local Qwen protocol", () => {
  it("accepts only literal loopback with no credentials/paths/query", () => {
    expect(localSpeechUrl("http://127.0.0.1:8766")).toBe("http://127.0.0.1:8766");
    expect(localSpeechUrl("http://[::1]:8766")).toBe("http://[::1]:8766");
    for (const url of ["https://example.com", "http://localhost:8766", "http://127.0.0.1:8766/path", "http://u:p@127.0.0.1:8766", "http://127.0.0.1:8766?key=x"]) expect(() => localSpeechUrl(url)).toThrow();
  });
  it("checks the service/model contract and forbids redirects", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ protocol: "hotclip-speech-v1", model: "Qwen/Qwen3-ASR-0.6B", aligner: true, device: "cpu", revision: "abc" })));
    vi.stubGlobal("fetch", fetcher);
    expect((await qwenHealth()).aligner).toBe(true);
    expect(fetcher.mock.calls[0][1].redirect).toBe("error");
    fetcher.mockResolvedValue(new Response(JSON.stringify({ protocol: "unrelated" })));
    await expect(qwenHealth()).rejects.toThrow("incompatible-service");
  });
  it("never accepts fabricated, overlapping or out-of-range time stamps", () => {
    expect(parseQwenWords([{ text: "Hello", start: 0.1, end: 0.5 }], 1, 20)[0]).toEqual({ text: "Hello", startSec: 20.1, endSec: 20.5, timingSource: "aligned" });
    for (const words of [[{ text: "x", start: 0, end: 9 }], [{ text: "x", start: NaN, end: 1 }], [{ text: "a", start: 0, end: 0.8 }, { text: "b", start: 0.2, end: 1 }]]) expect(() => parseQwenWords(words, 1)).toThrow();
  });
  it("keeps punctuation and interpolates a real aligner's zero-duration function word", () => {
    const words = qwenTranscriptWords("export a complete video.", [
      { text: "export", start: 0, end: 0.56 }, { text: "a", start: 0.56, end: 0.56 },
      { text: "complete", start: 0.56, end: 1.04 }, { text: "video", start: 1.04, end: 1.52 },
    ], 0, 1.7);
    expect(words.map((w) => w.text)).toEqual(["export", "a", "complete", "video."]);
    expect(words[1].timingSource).toBe("interpolated");
    expect(words.every((w) => w.endSec > w.startSec && w.endSec <= 1.7)).toBe(true);
  });
});
