import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  sanitizeGlossary,
  applyGlossaryToText,
  applyGlossaryToTranscript,
  countGlossaryHits,
  diffReplacement,
  upsertGlossaryEntry,
} from "../../shared/glossary";
import { loadGlossary, saveGlossary, glossaryPath } from "../glossary-store";
import type { Transcript } from "../../shared/api-types";

function makeTranscript(texts: string[]): Transcript {
  let t = 0;
  return {
    language: "zh",
    engine: "test",
    durationSec: texts.length * 3,
    segments: texts.map((text, i) => {
      const seg = {
        id: i + 1,
        startSec: t,
        endSec: t + 3,
        text,
        words: Array.from(text).map((ch, j) => ({
          text: ch,
          startSec: t + (3 * j) / text.length,
          endSec: t + (3 * (j + 1)) / text.length,
        })),
      };
      t += 3;
      return seg;
    }),
  };
}

describe("sanitizeGlossary", () => {
  it("丢弃空词/自指词/非法项,同错词去重留首条", () => {
    expect(
      sanitizeGlossary([
        { wrong: " 川普 ", right: "特朗普" },
        { wrong: "川普", right: "别的" }, // 重复错词,丢弃
        { wrong: "同词", right: "同词" }, // 自指,丢弃
        { wrong: "", right: "x" },
        { wrong: "x", right: "" },
        null,
        42,
      ])
    ).toEqual([{ wrong: "川普", right: "特朗普" }]);
  });

  it("非数组输入返回空表", () => {
    expect(sanitizeGlossary("broken")).toEqual([]);
    expect(sanitizeGlossary(undefined)).toEqual([]);
  });
});

describe("applyGlossaryToText", () => {
  it("中文子串替换", () => {
    expect(applyGlossaryToText("今天川普又发言了,川普说", [{ wrong: "川普", right: "特朗普" }])).toBe(
      "今天特朗普又发言了,特朗普说"
    );
  });

  it("拉丁词整词匹配:AI 不动 MAIN,且忽略大小写", () => {
    const entries = [{ wrong: "chatgpt", right: "ChatGPT" }];
    expect(applyGlossaryToText("我用 Chatgpt 和 CHATGPT 写代码", entries)).toBe("我用 ChatGPT 和 ChatGPT 写代码");
    expect(applyGlossaryToText("the MAIN point", [{ wrong: "AI", right: "人工智能" }])).toBe("the MAIN point");
  });

  it("多条同时命中取最长错词优先", () => {
    const entries = [
      { wrong: "open ai", right: "OpenAI" },
      { wrong: "ai", right: "AI" },
    ];
    expect(applyGlossaryToText("open ai 和 ai 都出现", entries)).toBe("OpenAI 和 AI 都出现");
  });

  it("单趟替换:替换结果不被其他词条二次改写", () => {
    const entries = [
      { wrong: "甲", right: "乙" },
      { wrong: "乙", right: "丙" },
    ];
    expect(applyGlossaryToText("甲乙", entries)).toBe("乙丙");
  });

  it("错词含正则特殊字符不炸", () => {
    expect(applyGlossaryToText("学 c++ 的人", [{ wrong: "c++", right: "C++" }])).toBe("学 C++ 的人");
  });

  it("多个错误变体映射同一对词", () => {
    const entries = [
      { wrong: "赛博朋克贰零柒柒", right: "赛博朋克2077" },
      { wrong: "赛博胖客2077", right: "赛博朋克2077" },
    ];
    expect(applyGlossaryToText("玩赛博胖客2077和赛博朋克贰零柒柒", entries)).toBe("玩赛博朋克2077和赛博朋克2077");
  });
});

describe("applyGlossaryToTranscript", () => {
  const entries = [{ wrong: "川普", right: "特朗普" }];

  it("只重建被改句,未改句保持原引用;整体没改返回原引用", () => {
    const t = makeTranscript(["川普发言了", "今天天气不错"]);
    const { transcript: out, replaced } = applyGlossaryToTranscript(t, entries);
    expect(replaced).toBe(1);
    expect(out.segments[0].text).toBe("特朗普发言了");
    expect(out.segments[0].glossaryApplied).toBe(true);
    expect(out.segments[1]).toBe(t.segments[1]); // 原引用

    const untouched = applyGlossaryToTranscript(makeTranscript(["今天天气不错"]), entries);
    expect(untouched.replaced).toBe(0);
  });

  it("被改句词级时间轴单调、首尾对齐原句区间", () => {
    const t = makeTranscript(["川普发言了"]);
    const { transcript: out } = applyGlossaryToTranscript(t, entries);
    const words = out.segments[0].words;
    expect(words[0].startSec).toBeCloseTo(t.segments[0].startSec, 6);
    expect(words[words.length - 1].endSec).toBeCloseTo(t.segments[0].endSec, 6);
    for (let i = 1; i < words.length; i++) {
      expect(words[i].startSec).toBeGreaterThanOrEqual(words[i - 1].startSec);
      expect(words[i].startSec).toBeCloseTo(words[i - 1].endSec, 6);
    }
  });

  it("保留说话人标注:句级 speaker 回填到重建的词", () => {
    const t = makeTranscript(["川普发言了"]);
    t.segments[0].speaker = 1;
    const { transcript: out } = applyGlossaryToTranscript(t, entries);
    expect(out.segments[0].words.every((w) => w.speaker === 1)).toBe(true);
  });

  it("countGlossaryHits 统计命中句数", () => {
    const t = makeTranscript(["川普一", "无关", "川普二"]);
    expect(countGlossaryHits(t, entries)).toBe(2);
    expect(countGlossaryHits(t, [])).toBe(0);
  });
});

describe("diffReplacement", () => {
  it("提取中文单点修改", () => {
    expect(diffReplacement("今天川普又发言了", "今天特朗普又发言了")).toEqual({ wrong: "川普", right: "特朗普" });
  });

  it("拉丁词边界外扩到整词", () => {
    expect(diffReplacement("we use chatgpt daily", "we use ChatGPT daily")).toEqual({
      wrong: "chatgpt",
      right: "ChatGPT",
    });
  });

  it("无修改/纯插入/纯删除/整句重写返回 null", () => {
    expect(diffReplacement("一样的", "一样的")).toBeNull();
    expect(diffReplacement("前后", "前中后")).toBeNull(); // 纯插入
    expect(diffReplacement("前中后", "前后")).toBeNull(); // 纯删除
    expect(
      diffReplacement("这句话完全不一样了吧这句话完全不一样了吧", "换成了一整句别的话内容和原来毫无重合之处")
    ).toBeNull(); // 两侧都超 16 字:整句重写而非术语纠错
  });
});

describe("upsertGlossaryEntry", () => {
  it("同错词覆盖旧对词,新词追加", () => {
    const base = [{ wrong: "a词", right: "旧" }];
    expect(upsertGlossaryEntry(base, { wrong: "a词", right: "新" })).toEqual([{ wrong: "a词", right: "新" }]);
    expect(upsertGlossaryEntry(base, { wrong: "b词", right: "乙" })).toEqual([
      { wrong: "a词", right: "旧" },
      { wrong: "b词", right: "乙" },
    ]);
  });
});

describe("glossary-store", () => {
  it("读写往返;缺文件/坏文件返回空表", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hotclip-glossary-"));
    expect(await loadGlossary(dir)).toEqual([]);
    await saveGlossary(dir, [{ wrong: "川普", right: "特朗普" }, { wrong: "x", right: "x" }]);
    expect(await loadGlossary(dir)).toEqual([{ wrong: "川普", right: "特朗普" }]); // 自指项被清洗
    expect(JSON.parse(await readFile(glossaryPath(dir), "utf8"))).toHaveLength(1);
    await writeFile(glossaryPath(dir), "{broken json", "utf8");
    expect(await loadGlossary(dir)).toEqual([]); // fail-open
  });
});
