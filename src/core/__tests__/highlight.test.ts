import { describe, it, expect } from "vitest";
import { normalizeText, buildTokenIndex, matchQuote, resolveSelection } from "../highlight/match";
import { parseSelections, dropOverlaps, parseReviews, applyReviews } from "../highlight/detect";
import {
  buildHighlightPrompt,
  renderTranscriptLines,
  extractJson,
  isChineseTranscript,
  highlightSystemPrompt,
  renderSignals,
} from "../highlight/prompt";
import type { Transcript, TranscriptWord } from "../transcribe/types";
import type { HighlightCandidate } from "../../shared/api-types";

/** Build a transcript from sentences: each char = one 0.2s token (zh-style). */
function makeTranscript(sentences: string[]): Transcript {
  let t = 0;
  let id = 0;
  const segments = sentences.map((text) => {
    id++;
    const words: TranscriptWord[] = Array.from(text).map((ch, i) => ({
      text: ch,
      startSec: t + i * 0.2,
      endSec: t + (i + 1) * 0.2,
    }));
    const seg = { id, startSec: words[0].startSec, endSec: words[words.length - 1].endSec, text, words };
    t = seg.endSec + 0.5;
    return seg;
  });
  return { language: "zh", segments, engine: "test", durationSec: t };
}

describe("normalizeText", () => {
  it("drops punctuation/whitespace, lowercases latin, keeps CJK", () => {
    expect(normalizeText("你好，世界！ Hello, World!")).toBe("你好世界helloworld");
  });
});

describe("matchQuote", () => {
  const tx = makeTranscript(["今天天气真好。", "我们来聊聊赚钱这件事。", "记住这三个字:别上头。"]);
  const index = buildTokenIndex(tx.segments.flatMap((s) => s.words));

  it("exact contiguous match returns precise token times", () => {
    const m = matchQuote(index, "我们来聊聊", "赚钱这件事。");
    expect(m).not.toBeNull();
    expect(m!.boundary).toBe("exact");
    expect(m!.startSec).toBeCloseTo(tx.segments[1].startSec, 3);
    expect(m!.endSec).toBeCloseTo(tx.segments[1].endSec, 3);
  });

  it("anchored match spans head→tail across sentences", () => {
    const m = matchQuote(index, "我们来聊聊赚钱", "别上头。");
    expect(m).not.toBeNull();
    expect(m!.boundary).toBe("anchored");
    expect(m!.startSec).toBeCloseTo(tx.segments[1].startSec, 3);
    expect(m!.endSec).toBeCloseTo(tx.segments[2].endSec, 3);
  });

  it("quote punctuation differences do not break matching", () => {
    const m = matchQuote(index, "记住这三个字", "别上头");
    expect(m).not.toBeNull();
  });

  it("returns null when text is absent", () => {
    expect(matchQuote(index, "根本不存在的话", "也不存在")).toBeNull();
  });
});

describe("resolveSelection", () => {
  const tx = makeTranscript(["开场白很平淡。", "但是接下来这句话炸了。", "这就是全网疯传的那个观点。", "后面又归于平静。"]);

  it("resolves via quotes scoped to declared segments", () => {
    const r = resolveSelection(tx, {
      title: "t", hook: "h", score: 90, reason: "r", keywords: [],
      startSegmentId: 2, endSegmentId: 3,
      quoteStart: "但是接下来", quoteEnd: "那个观点。",
    });
    expect(r).not.toBeNull();
    expect(r!.boundary).toBe("anchored");
    expect(r!.startSec).toBeCloseTo(tx.segments[1].startSec, 3);
    expect(r!.endSec).toBeCloseTo(tx.segments[2].endSec, 3);
    expect(r!.text).toContain("炸了");
  });

  it("falls back to segment boundaries when quotes are hallucinated", () => {
    const r = resolveSelection(tx, {
      title: "t", hook: "h", score: 50, reason: "r", keywords: [],
      startSegmentId: 2, endSegmentId: 3,
      quoteStart: "LLM自己编的话", quoteEnd: "完全对不上",
    });
    expect(r).not.toBeNull();
    expect(r!.boundary).toBe("segment");
    expect(r!.startSec).toBeCloseTo(tx.segments[1].startSec, 3);
  });

  it("returns null when nothing is locatable", () => {
    const r = resolveSelection(tx, {
      title: "t", hook: "h", score: 50, reason: "r", keywords: [],
      startSegmentId: 99, endSegmentId: 98,
      quoteStart: "不存在", quoteEnd: "也不存在",
    });
    expect(r).toBeNull();
  });
});

describe("parseSelections", () => {
  it("parses fenced JSON and clamps score", () => {
    const out = parseSelections('```json\n{"clips":[{"title":"钩子","score":150,"startSegmentId":1,"endSegmentId":2,"quoteStart":"开头","quoteEnd":"结尾"}]}\n```');
    expect(out).toHaveLength(1);
    expect(out[0].score).toBe(100);
  });

  it("drops rows without any locator and throws on non-JSON", () => {
    const out = parseSelections('{"clips":[{"title":"没定位"},{"quoteStart":"有引文","startSegmentId":1,"endSegmentId":1,"quoteEnd":"x"}]}');
    expect(out).toHaveLength(1);
    expect(() => parseSelections("总之就是不输出JSON")).toThrow();
  });
});

describe("parseReviews / applyReviews", () => {
  it("parses verdicts and tolerates fenced JSON", () => {
    const out = parseReviews('```json\n{"reviews":[{"id":1,"keep":false,"score":30,"note":"平淡"},{"id":2,"keep":true,"score":88}]}\n```');
    expect(out).toEqual([
      { id: 1, keep: false, score: 30, note: "平淡" },
      { id: 2, keep: true, score: 88, note: "" },
    ]);
  });

  it("applies verdicts and fails open for unreviewed ids", () => {
    const base = {
      startSec: 0, endSec: 10, text: "", title: "", hook: "", reason: "",
      boundary: "exact" as const, keywords: [], recommended: true, reviewNote: "",
    };
    const cands = [
      { ...base, id: 1, score: 90 },
      { ...base, id: 2, score: 80 },
    ];
    const out = applyReviews(cands, [{ id: 1, keep: false, score: 35, note: "弱钩子" }]);
    expect(out[0]).toMatchObject({ recommended: false, score: 35, reviewNote: "弱钩子" });
    expect(out[1]).toMatchObject({ recommended: true, score: 80 });
  });

  it("throws on malformed reviewer output", () => {
    expect(() => parseReviews("完全不是JSON")).toThrow();
  });
});

describe("dropOverlaps", () => {
  const c = (id: number, s: number, e: number, score: number): HighlightCandidate => ({
    id, startSec: s, endSec: e, text: "", title: "", hook: "", score, reason: "", boundary: "exact", keywords: [], recommended: true, reviewNote: "",
  });

  it("keeps higher-scored clip among overlaps, renumbers by time order", () => {
    const kept = dropOverlaps([c(1, 0, 20, 70), c(2, 10, 30, 90), c(3, 40, 60, 50)]);
    expect(kept).toHaveLength(2);
    expect(kept[0].score).toBe(90);
    expect(kept.map((k) => k.id)).toEqual([1, 2]);
  });
});

describe("prompt builders", () => {
  const tx = makeTranscript(["第一句。", "第二句。"]);

  it("renders [id] MM:SS lines", () => {
    const lines = renderTranscriptLines(tx).split("\n");
    expect(lines[0]).toMatch(/^\[1\] 00:00 第一句。$/);
    expect(lines[1]).toMatch(/^\[2\] 00:0\d 第二句。$/);
  });

  it("prompt forbids timestamps and demands verbatim quotes", () => {
    const p = buildHighlightPrompt(tx);
    expect(p).toContain("quoteStart");
    expect(p).toContain("startSegmentId");
    expect(p).toContain("逐句稿");
  });

  it("extractJson handles fences and prose-wrapped objects", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('好的,结果如下 {"a":1} 请查收')).toBe('{"a":1}');
  });
});

describe("prompt language routing（中英分流）", () => {
  const zhTx = makeTranscript(["今天聊聊怎么把长视频切成爆款。", "关键就三个字。"]);
  const enTx: Transcript = {
    language: "en",
    engine: "test",
    durationSec: 10,
    segments: [
      {
        id: 1,
        startSec: 0,
        endSec: 4,
        text: "Today we talk about turning long videos into viral shorts.",
        words: [{ text: "Today", startSec: 0, endSec: 0.4 }],
      },
    ],
  };

  it("zh transcript → Chinese system + user prompt", () => {
    expect(isChineseTranscript(zhTx)).toBe(true);
    expect(highlightSystemPrompt(zhTx)).toContain("切片操盘手");
    expect(buildHighlightPrompt(zhTx)).toContain("逐句稿");
  });

  it("en transcript → English system + user prompt, no Chinese leakage", () => {
    expect(isChineseTranscript(enTx)).toBe(false);
    const sys = highlightSystemPrompt(enTx);
    const user = buildHighlightPrompt(enTx);
    expect(sys).toContain("clipping strategist");
    expect(user).toContain("Transcript");
    expect(/[一-鿿]/.test(sys)).toBe(false);
    // user prompt carries only the transcript text itself, which here is English
    expect(/[一-鿿]/.test(user)).toBe(false);
  });

  it("auto language falls back to CJK-dominance detection", () => {
    const autoTx: Transcript = { ...zhTx, language: "auto" };
    expect(isChineseTranscript(autoTx)).toBe(true);
    const autoEn: Transcript = { ...enTx, language: "auto" };
    expect(isChineseTranscript(autoEn)).toBe(false);
  });
});

describe("renderSignals / signal injection", () => {
  const signals = {
    loudPeaks: [{ startSec: 192, endSec: 198 }],
    cutDense: [{ startSec: 500, endSec: 515 }],
  };

  it("renders bilingual signal blocks with MM:SS ranges", () => {
    const zh = renderSignals(signals, true);
    expect(zh).toContain("画面与声音信号");
    expect(zh).toContain("03:12-03:18");
    const en = renderSignals(signals, false);
    expect(en).toContain("Audiovisual signals");
    expect(en).toContain("08:20-08:35");
  });

  it("empty signals render nothing", () => {
    expect(renderSignals({ loudPeaks: [], cutDense: [] }, true)).toBe("");
    expect(renderSignals(undefined, true)).toBe("");
  });

  it("buildHighlightPrompt embeds the signal section when provided", () => {
    const tx = makeTranscript(["第一句话。", "第二句话。"]);
    expect(buildHighlightPrompt(tx, 6, signals)).toContain("画面与声音信号");
    expect(buildHighlightPrompt(tx)).not.toContain("画面与声音信号");
  });
});
