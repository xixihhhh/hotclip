import { describe, expect, it } from "vitest";
import { parseSubtitleTranscript, SUBTITLE_IMPORT_MAX_BYTES, subtitleImportError } from "../subtitle-import";
import { summarizeTimingQuality } from "../transcript-quality";
import { editSegmentText, tokenizeForWords } from "../edit-transcript";

const srt = (body = "Hello world", start = "00:00:01,250", end = "00:00:03,750") => `1\n${start} --> ${end}\n${body}\n`;

describe("subtitle transcript interchange", () => {
  it("preserves BOM/CRLF cue boundaries and marks every word as estimated", () => {
    const transcript = parseSubtitleTranscript(`\uFEFF${srt("你好，world!").replace(/\n/g, "\r\n")}`, "srt", 8);
    expect(transcript).toMatchObject({ engine: "subtitle-srt", language: "auto", durationSec: 8 });
    const segment = transcript.segments[0];
    expect(segment).toMatchObject({ id: 1, startSec: 1.25, endSec: 3.75, text: "你好，world!" });
    expect(segment.words.map((word) => word.text)).toEqual(["你", "好，", "world!"]);
    expect(segment.words[0].startSec).toBe(1.25);
    expect(segment.words.at(-1)?.endSec).toBe(3.75);
    expect(summarizeTimingQuality(segment.words).uncertainWords).toBe(3);
    expect(segment.words.every((word) => word.timingSource === "estimated")).toBe(true);
  });

  it("imports long-hour SRT, optional indices and multiline payloads", () => {
    const transcript = parseSubtitleTranscript("26:00:01.000 --> 26:00:02.500\nFirst line\nsecond line", "srt", 100_000);
    expect(transcript.segments[0]).toMatchObject({ startSec: 93601, endSec: 93602.5, text: "First line second line" });
  });

  it("handles VTT headers, cue identifiers, settings, comments, regions and presentation tags", () => {
    const text = `WEBVTT - interview\nKind: captions\n\nNOTE an annotation\nnot spoken\n\nSTYLE\n::cue { color: lime; }\n\nREGION\nid:foo\n\nfirst\n00:01.000 --> 00:03.000 align:start position:10%\n<v Guest><c.green>Hello</c> <00:02.000><i>world</i></v>\n\n00:00:04.000 --> 00:00:06.000\n<ruby>字<rt>zi</rt></ruby> &amp; &#x1F408; &lt;tag&gt;`;
    const transcript = parseSubtitleTranscript(text, "vtt", 8);
    expect(transcript.segments.map((segment) => segment.text)).toEqual(["Hello world", "字 & 🐈 <tag>"]);
    expect(transcript.segments[0].speaker).toBeUndefined(); // names are not diarization evidence
    expect(transcript.engine).toBe("subtitle-vtt");
    expect(transcript.segments.flatMap((segment) => segment.words).every((word) => word.timingSource === "estimated")).toBe(true);
  });

  it("keeps encoded tags as plain text and strips SRT styling without executing markup", () => {
    const transcript = parseSubtitleTranscript(srt('{\\an8}<font color="red">2 &lt; 3</font><br>Tom &amp; Jerry &#39;yes&#39;'), "srt", 8);
    expect(transcript.segments[0].text).toBe("2 < 3 Tom & Jerry 'yes'");
  });

  it("preserves multilingual word units and combining marks during import and correction", () => {
    const text = "café mañana déjà nai\u0308ve Привет مرحبا";
    expect(tokenizeForWords(text)).toEqual(text.split(" "));
    const transcript = parseSubtitleTranscript(srt(text), "srt", 8);
    expect(transcript.segments[0].words.map((word) => word.text)).toEqual(text.split(" "));
    const edited = editSegmentText(transcript, 1, "café завтра");
    expect(edited.segments[0].words.map((word) => word.text)).toEqual(["café", "завтра"]);
    expect(edited.segments[0].words.every((word) => word.timingSource === "edited")).toBe(true);
    expect(transcript.segments[0].text).toBe(text);
  });

  it.each([
    ["", "empty"],
    ["not a subtitle", "cue"],
    [srt("", "00:00:01,000", "00:00:02,000"), "cue"],
    [srt("<b></b>"), "cue"],
    [srt("test", "00:60:00,000"), "cue"],
    [srt("test", "-00:00:01,000"), "cue"],
    [srt("test", "00:00:03,750"), "cue"],
    [srt("test", "00:00:04,000"), "cue"],
    [srt("test", "00:00:01,250", "00:00:09,000"), "range"],
    [srt("test\u0000"), "encoding"],
    [srt("test\uFFFD"), "encoding"],
    [srt("x") + srt("y"), "cue"],
    [srt("x") + "\n" + srt("y"), "overlap"],
    [srt("字".repeat(8001)), "limit"],
    ["x".repeat(SUBTITLE_IMPORT_MAX_BYTES + 1), "size"],
    ["字".repeat(Math.ceil(SUBTITLE_IMPORT_MAX_BYTES / 3)), "size"],
  ])("rejects invalid SRT input (%#) without a partial transcript", (text, code) => {
    expect(() => parseSubtitleTranscript(text, "srt", 8)).toThrow(`subtitle-import:${code}:`);
  });

  it("rejects backwards ordering and permits exactly touching cues", () => {
    expect(() => parseSubtitleTranscript(srt() + "\n" + srt("back", "00:00:00,000", "00:00:01,000"), "srt", 8)).toThrow("overlap:2");
    const t = parseSubtitleTranscript(srt() + "\n" + srt("next", "00:00:03,750", "00:00:08,000"), "srt", 8);
    expect(t.segments).toHaveLength(2);
    expect(t.segments[1].endSec).toBe(8);
  });

  it("rejects VTT clock mappings and a missing header", () => {
    expect(() => parseSubtitleTranscript("00:01.000 --> 00:02.000\nhi", "vtt", 8)).toThrow("format");
    expect(() => parseSubtitleTranscript("WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00.000,MPEGTS:900000\n\n00:01.000 --> 00:02.000\nhi", "vtt", 8)).toThrow("mapped");
    expect(() => parseSubtitleTranscript("WEBVTT\n00:01.000 --> 00:02.000\nhi", "vtt", 8)).toThrow("cue");
    expect(() => parseSubtitleTranscript("WEBVTT\n\nNOTE no captions", "vtt", 8)).toThrow("empty");
  });

  it("requires a finite positive source duration", () => {
    for (const duration of [0, -1, NaN, Infinity]) {
      expect(() => parseSubtitleTranscript(srt(), "srt", duration)).toThrow("range");
    }
  });

  it("recovers actionable cue errors through IPC wrappers", () => {
    expect(subtitleImportError(new Error("Error invoking remote method: Error: subtitle-import:overlap:12"))).toEqual({ code: "overlap", cue: 12 });
    expect(subtitleImportError(new Error("unrelated"))).toBeNull();
  });
});
