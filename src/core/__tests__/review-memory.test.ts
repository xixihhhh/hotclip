import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadReviewMemory,
  recordReview,
  pickExamples,
  reviewMemorySection,
  type ReviewRecord,
  type ReviewedCandidate,
} from "../review-memory";
import { highlightSystemPrompt } from "../highlight/prompt";
import type { Transcript } from "../transcribe/types";

const cand = (title: string, over: Partial<ReviewedCandidate> = {}): ReviewedCandidate => ({
  title,
  hook: `${title}的钩子`,
  score: 80,
  durationSec: 20,
  ...over,
});

const rec = (over: Partial<ReviewRecord> = {}): ReviewRecord => ({
  at: "2026-07-24T00:00:00.000Z",
  video: "直播回放.mp4",
  kept: [],
  rejected: [],
  ...over,
});

let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
const freshDir = async (): Promise<string> => (root = await mkdtemp(join(tmpdir(), "hotclip-rm-")));

describe("loadReviewMemory / recordReview", () => {
  it("缺文件/坏 JSON 一律当空,不抛错", async () => {
    const dir = await freshDir();
    expect(await loadReviewMemory(dir)).toEqual([]);
    await writeFile(join(dir, "review-memory.json"), "{oops", "utf8");
    expect(await loadReviewMemory(dir)).toEqual([]);
  });

  it("追加并裁旧到 40 场;落盘可读回", async () => {
    const dir = await freshDir();
    for (let i = 0; i < 42; i++) {
      await recordReview(dir, rec({ at: `2026-07-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`, kept: [cand(`片${i}`)] }));
    }
    const all = await loadReviewMemory(dir);
    expect(all).toHaveLength(40);
    // 最老的两场被裁掉
    expect(all[0].kept[0].title).toBe("片2");
    // 文件确实是 JSON
    expect(JSON.parse(await readFile(join(dir, "review-memory.json"), "utf8"))).toHaveLength(40);
  });
});

describe("pickExamples", () => {
  it("新场次优先、标题去重、每类上限 6", () => {
    const records = [
      rec({ rejected: [cand("旧片"), cand("重复片")] }),
      rec({ rejected: [cand("重复片"), cand("新1"), cand("新2"), cand("新3"), cand("新4"), cand("新5")] }),
    ];
    const out = pickExamples(records, "rejected");
    expect(out).toHaveLength(6);
    // 最新场次的排前面,"重复片"只出现一次
    expect(out.map((c) => c.title)).toEqual(["重复片", "新1", "新2", "新3", "新4", "新5"]);
  });
});

describe("reviewMemorySection", () => {
  it("空记忆返回空串", () => {
    expect(reviewMemorySection([], true)).toBe("");
    expect(reviewMemorySection([rec()], true)).toBe("");
  });

  it("中文段带否决/采用样例与'总结共性'指引", () => {
    const s = reviewMemorySection(
      [rec({ rejected: [cand("纯口播闲聊", { score: 88 })], kept: [cand("实测演示", { keywords: ["抽纸"] })] })],
      true
    );
    expect(s).toContain("【用户审阅偏好】");
    expect(s).toContain("《纯口播闲聊》");
    expect(s).toContain("当时评分 88");
    expect(s).toContain("《实测演示》");
    expect(s).toContain("关键词:抽纸");
    expect(s).toContain("共性");
  });

  it("英文段同构", () => {
    const s = reviewMemorySection([rec({ rejected: [cand("talking head ramble")] })], false);
    expect(s).toContain("[User review history]");
    expect(s).toContain('"talking head ramble"');
  });
});

describe("highlightSystemPrompt 注入", () => {
  const zhTranscript: Transcript = {
    language: "zh",
    durationSec: 60,
    segments: [{ id: 1, startSec: 0, endSec: 5, text: "今天给大家带来一款超级好用的抽纸。" }],
  } as Transcript;

  it("有记忆时 system prompt 携带偏好段;无记忆不变", () => {
    const memory = [rec({ rejected: [cand("纯口播闲聊")] })];
    const withMemory = highlightSystemPrompt(zhTranscript, "standard", [], undefined, memory);
    expect(withMemory).toContain("【用户审阅偏好】");
    const without = highlightSystemPrompt(zhTranscript, "standard", [], undefined, undefined);
    expect(without).not.toContain("【用户审阅偏好】");
  });
});
