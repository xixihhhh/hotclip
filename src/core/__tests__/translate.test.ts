import { describe, it, expect } from "vitest";
import {
  collectClipSegments,
  translationUserPrompt,
  parseTranslationLines,
  chunkForTranslate,
  translateSegments,
  clipTranslationLines,
  clampTranslationLines,
  remapTranslationLines,
  type TranslatableSegment,
  type TranslateChatFn,
} from "../translate";
import type { Transcript } from "../transcribe/types";

const LLM = { baseUrl: "http://x/v1", apiKey: "k", model: "m" };

// n 句转写,每句 4 秒
function mockTranscript(n: number): Transcript {
  return {
    language: "zh",
    engine: "mock",
    durationSec: n * 4,
    segments: Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      startSec: i * 4,
      endSec: i * 4 + 3.5,
      text: `第${i + 1}句`,
      words: [],
    })),
  };
}

describe("collectClipSegments", () => {
  it("只收切片覆盖(含 pad)的句子,跨切片去重", () => {
    const t = mockTranscript(20);
    const segs = collectClipSegments(t, [
      { startSec: 8, endSec: 16 }, // 句 3-5(pad 后含句 2 尾部? 句2 endSec=7.5>8-1.5=6.5 → 含)
      { startSec: 12, endSec: 20 }, // 与上一片重叠
    ]);
    const ids = segs.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length); // 去重
    expect(ids).toContain(3);
    expect(ids).toContain(5);
    expect(ids).not.toContain(10);
  });
});

describe("parseTranslationLines", () => {
  it("解析标准输出并按 validIds 过滤", () => {
    const map = parseTranslationLines(
      '{"lines":[{"id":1,"text":"Hello"},{"id":2,"text":"World"},{"id":99,"text":"bad"}]}',
      new Set([1, 2])
    );
    expect(map.get(1)).toBe("Hello");
    expect(map.get(2)).toBe("World");
    expect(map.has(99)).toBe(false);
  });

  it("剥 think 块;垃圾输出返回空 Map", () => {
    expect(parseTranslationLines('<think>嗯</think>{"lines":[{"id":1,"text":"Hi"}]}', new Set([1])).get(1)).toBe("Hi");
    expect(parseTranslationLines("对不起我做不到", new Set([1])).size).toBe(0);
    expect(parseTranslationLines('{"lines":"不是数组"}', new Set([1])).size).toBe(0);
  });
});

describe("chunkForTranslate", () => {
  it("按字符预算整句切块", () => {
    const segs: TranslatableSegment[] = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1, startSec: i, endSec: i + 1, text: "字".repeat(500),
    }));
    const chunks = chunkForTranslate(segs, 1800);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat().length).toBe(10);
    for (const c of chunks) expect(c.reduce((a, s) => a + s.text.length, 0)).toBeLessThanOrEqual(2000);
  });
});

describe("translateSegments", () => {
  const segs: TranslatableSegment[] = [
    { id: 1, startSec: 0, endSec: 3, text: "你好" },
    { id: 2, startSec: 4, endSec: 7, text: "世界" },
  ];

  it("正常路径返回 id→译文", async () => {
    const chat: TranslateChatFn = async (_llm, _sys, user) => {
      expect(user).toContain("[1] 你好");
      return '{"lines":[{"id":1,"text":"Hello"},{"id":2,"text":"World"}]}';
    };
    const map = await translateSegments(segs, "en", LLM, chat);
    expect(map?.get(2)).toBe("World");
  });

  it("端点全挂 fail-open 返回 null", async () => {
    const chat: TranslateChatFn = async () => { throw new Error("ECONNREFUSED"); };
    expect(await translateSegments(segs, "en", LLM, chat)).toBeNull();
  });

  it("上游取消原样上抛", async () => {
    const ac = new AbortController();
    ac.abort();
    const chat: TranslateChatFn = async () => { throw new Error("aborted"); };
    await expect(translateSegments(segs, "en", LLM, chat, ac.signal)).rejects.toThrow();
  });

  it("空输入返回 null", async () => {
    const chat: TranslateChatFn = async () => "{}";
    expect(await translateSegments([], "en", LLM, chat)).toBeNull();
  });
});

describe("clipTranslationLines / clampTranslationLines", () => {
  const segs: TranslatableSegment[] = [
    { id: 1, startSec: 0, endSec: 4, text: "一" },
    { id: 2, startSec: 4, endSec: 8, text: "二" },
    { id: 3, startSec: 8, endSec: 12, text: "三" },
  ];
  const tr = new Map([[1, "one"], [2, "two"], [3, "three"]]);

  it("只取落在切片内的句子,时间夹进切片", () => {
    const lines = clipTranslationLines(segs, tr, 3, 9);
    expect(lines.map((l) => l.text)).toEqual(["one", "two", "three"]);
    expect(lines[0].startSec).toBe(3); // 夹到切片起点
    expect(lines[2].endSec).toBe(9); // 夹到切片终点
  });

  it("没有译文的句子跳过;交集太短丢弃", () => {
    const partial = new Map([[2, "two"]]);
    expect(clipTranslationLines(segs, partial, 0, 12).length).toBe(1);
    expect(clipTranslationLines(segs, tr, 3.9, 9).map((l) => l.text)).toEqual(["two", "three"]); // 句1只剩0.1s
  });

  it("clamp 助手同样按最短时长过滤", () => {
    const lines = [{ startSec: 0, endSec: 10, text: "x" }, { startSec: 11.9, endSec: 12, text: "y" }];
    const out = clampTranslationLines(lines, 2, 12);
    expect(out.length).toBe(1);
    expect(out[0]).toEqual({ startSec: 2, endSec: 10, text: "x" });
  });
});

describe("remapTranslationLines", () => {
  // 保留段:[10,14] 和 [16,20] → 输出 0-4 与 4-8
  const kept = [
    { startSec: 10, endSec: 14 },
    { startSec: 16, endSec: 20 },
  ];

  it("跨剪切点的行取交集首尾(中段被剪掉)", () => {
    const out = remapTranslationLines([{ startSec: 12, endSec: 18, text: "跨" }], kept);
    expect(out.length).toBe(1);
    expect(out[0].startSec).toBeCloseTo(2); // 12 在段1内偏移2
    expect(out[0].endSec).toBeCloseTo(6); // 18 在段2内偏移2 + 前段4秒
  });

  it("完全落在被剪区间的行丢弃", () => {
    expect(remapTranslationLines([{ startSec: 14.2, endSec: 15.8, text: "剪" }], kept)).toEqual([]);
  });

  it("完整落在保留段内的行原样平移", () => {
    const out = remapTranslationLines([{ startSec: 16.5, endSec: 19, text: "在" }], kept);
    expect(out[0].startSec).toBeCloseTo(4.5);
    expect(out[0].endSec).toBeCloseTo(7);
  });
});

describe("translationUserPrompt", () => {
  it("id 与原文逐行成对", () => {
    const p = translationUserPrompt([
      { id: 7, startSec: 0, endSec: 1, text: "你好" },
      { id: 8, startSec: 1, endSec: 2, text: "再见" },
    ]);
    expect(p).toBe("[7] 你好\n[8] 再见");
  });
});
