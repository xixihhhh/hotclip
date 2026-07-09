import { describe, it, expect } from "vitest";
import {
  chunkSegments,
  stripThinkBlocks,
  parseWindows,
  expandAndMergeWindows,
  filterTranscriptByIds,
  funnelStats,
  prefilterTranscript,
  prefilterUserPrompt,
  PREFILTER_MIN_CHARS,
  type ChatFn,
} from "../highlight/prefilter";
import type { Transcript, TranscriptSegment } from "../transcribe/types";

// 构造 n 句转写,每句 text 重复到指定长度
function mockTranscript(n: number, charsPerSeg = 40): Transcript {
  const segments: TranscriptSegment[] = Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    startSec: i * 4,
    endSec: i * 4 + 3.5,
    text: `第${i + 1}句内容`.padEnd(charsPerSeg, "话"),
    words: [],
  }));
  return { language: "zh", engine: "mock", durationSec: n * 4, segments };
}

describe("chunkSegments", () => {
  it("按累计字符切块,整句为单位", () => {
    const t = mockTranscript(50, 100); // 5000 字
    const chunks = chunkSegments(t.segments, 1000);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.flat().length).toBe(50); // 一句不丢
    for (const c of chunks) expect(c.length).toBeGreaterThan(0);
  });

  it("单句超长也成块(不死循环)", () => {
    const t = mockTranscript(2, 5000);
    expect(chunkSegments(t.segments, 1000).length).toBe(2);
  });
});

describe("stripThinkBlocks / parseWindows", () => {
  const ids = new Set([1, 2, 3, 4, 5, 6, 7, 8]);

  it("剥掉 <think> 块后解析 JSON(qwen3 推理输出形态)", () => {
    const content = `<think>嗯,{要仔细想想}这段…</think>\n{"windows":[{"start":2,"end":5}]}`;
    expect(parseWindows(content, ids)).toEqual([{ start: 2, end: 5 }]);
    expect(stripThinkBlocks("<think>a</think>rest")).toBe("rest");
  });

  it("非法 id / 缺字段的窗口被丢弃;start>end 自动交换", () => {
    const content = `{"windows":[{"start":99,"end":100},{"start":5,"end":3},{"end":4}]}`;
    expect(parseWindows(content, ids)).toEqual([{ start: 3, end: 5 }]);
  });

  it("完全不可解析时抛错(调用方回退)", () => {
    expect(() => parseWindows("我觉得都不错!", ids)).toThrow();
    expect(() => parseWindows(`{"clips":[]}`, ids)).toThrow();
  });
});

describe("expandAndMergeWindows / filterTranscriptByIds", () => {
  const orderedIds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  it("每侧外扩 pad 句并合并重叠", () => {
    const kept = expandAndMergeWindows([{ start: 4, end: 5 }, { start: 6, end: 7 }], orderedIds, 1);
    // 4-5 扩成 3-6;6-7 扩成 5-8 → 合并 3-8
    expect([...kept].sort((a, b) => a - b)).toEqual([3, 4, 5, 6, 7, 8]);
  });

  it("外扩不越过稿件两端", () => {
    const kept = expandAndMergeWindows([{ start: 1, end: 2 }], orderedIds, 3);
    expect(Math.min(...kept)).toBe(1);
  });

  it("过滤后的转写保留原 id(云端引用可在全稿反查)", () => {
    const t = mockTranscript(10);
    const filtered = filterTranscriptByIds(t, new Set([3, 7]));
    expect(filtered.segments.map((s) => s.id)).toEqual([3, 7]);
    const stats = funnelStats(t, filtered);
    expect(stats.totalSegments).toBe(10);
    expect(stats.keptSegments).toBe(2);
    expect(stats.keptChars).toBeLessThan(stats.totalChars);
  });
});

describe("prefilterUserPrompt", () => {
  it("qwen3 模型附加 /no_think,其他模型不加", () => {
    const seg = mockTranscript(2).segments;
    expect(prefilterUserPrompt(seg, true, "qwen3:4b")).toContain("/no_think");
    expect(prefilterUserPrompt(seg, true, "llama3.2:3b")).not.toContain("/no_think");
  });
});

describe("prefilterTranscript(注入假 chat)", () => {
  const local = { baseUrl: "http://localhost:11434/v1", apiKey: "ollama", model: "qwen3:4b" };

  it("正常路径:圈出窗口 → 过滤转写 + 漏斗统计", async () => {
    const t = mockTranscript(100, 60); // 6000 字,3 块左右
    const chat: ChatFn = async (_l, _s, user) => {
      // 每块圈第一、二句为一个窗口
      const m = user.match(/\[(\d+)\]/);
      const first = Number(m![1]);
      return `{"windows":[{"start":${first},"end":${first + 1}}]}`;
    };
    const out = await prefilterTranscript(t, local, chat);
    expect(out).not.toBeNull();
    expect(out!.transcript.segments.length).toBeLessThan(100 * 0.85);
    expect(out!.funnel.totalSegments).toBe(100);
    expect(out!.funnel.keptChars).toBeLessThan(out!.funnel.totalChars);
    // 入围句保留原 id
    expect(out!.transcript.segments.every((s) => t.segments.some((o) => o.id === s.id))).toBe(true);
  });

  it("稿太短不启用", async () => {
    const t = mockTranscript(5, 40); // 200 字 < 阈值
    expect(PREFILTER_MIN_CHARS).toBeGreaterThan(200);
    const chat: ChatFn = async () => `{"windows":[]}`;
    expect(await prefilterTranscript(t, local, chat)).toBeNull();
  });

  it("端点全挂 → null(回退全文)", async () => {
    const t = mockTranscript(100, 60);
    const chat: ChatFn = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect(await prefilterTranscript(t, local, chat)).toBeNull();
  });

  it("小模型判全无爆点 → null(不可信,全文直发)", async () => {
    const t = mockTranscript(100, 60);
    const chat: ChatFn = async () => `{"windows":[]}`;
    expect(await prefilterTranscript(t, local, chat)).toBeNull();
  });

  it("单块失败 → 该块整块入围,其余照筛", async () => {
    const t = mockTranscript(100, 60);
    let call = 0;
    const chat: ChatFn = async (_l, _s, user) => {
      if (call++ === 0) throw new Error("timeout"); // 第一块挂
      const m = user.match(/\[(\d+)\]/);
      const first = Number(m![1]);
      return `{"windows":[{"start":${first},"end":${first + 1}}]}`;
    };
    const out = await prefilterTranscript(t, local, chat);
    expect(out).not.toBeNull();
    // 第一块的句子全部在场(fail-open 到"多花钱"而不是"漏内容")
    expect(out!.transcript.segments.some((s) => s.id === 1)).toBe(true);
  });

  it("筛不掉多少(≥85%)就不启用漏斗", async () => {
    const t = mockTranscript(20, 200); // 单块 4000 字
    const chat: ChatFn = async () => `{"windows":[{"start":1,"end":20}]}`; // 全入围
    expect(await prefilterTranscript(t, local, chat)).toBeNull();
  });
});
