import { describe, it, expect } from "vitest";
import {
  publishSystemPrompt,
  publishUserPrompt,
  parsePublishCopies,
  generatePublishCopies,
  postTextFile,
  type PublishSource,
  type PublishChatFn,
} from "../publish";

const LLM = { baseUrl: "http://x/v1", apiKey: "k", model: "m" };

const SOURCES: PublishSource[] = [
  { id: 1, title: "半杯水都不渗", hook: "你看这个吸水速度", text: "正文".repeat(400), keywords: ["吸水速度"] },
  { id: 2, title: "差价10倍", hook: "有什么区别", text: "正文", keywords: [] },
];

describe("publishUserPrompt", () => {
  it("素材逐条成段,正文截断到 300 字", () => {
    const p = publishUserPrompt(SOURCES);
    expect(p).toContain("[1] 片名:半杯水都不渗 钩子:你看这个吸水速度 关键词:吸水速度");
    expect(p).toContain("[2]");
    const line1 = p.split("\n\n")[0];
    expect(line1.length).toBeLessThan(400);
  });
});

describe("parsePublishCopies", () => {
  it("解析标准输出,# 前缀自动补齐,标签截到 6 个", () => {
    const content = JSON.stringify({
      posts: [
        { id: 1, title: "倒半杯水会怎样?", hashtags: ["#纸巾测评", "好物推荐", "#a", "#b", "#c", "#d", "#e"], description: "实测给你看。" },
      ],
    });
    const map = parsePublishCopies(content, new Set([1]));
    const c = map.get(1)!;
    expect(c.title).toBe("倒半杯水会怎样?");
    expect(c.hashtags[1]).toBe("#好物推荐"); // 自动补 #
    expect(c.hashtags.length).toBe(6);
    expect(c.description).toBe("实测给你看。");
  });

  it("无效条目跳过:缺标题/未知 id/垃圾输出", () => {
    expect(parsePublishCopies('{"posts":[{"id":1,"hashtags":[]}]}', new Set([1])).size).toBe(0);
    expect(parsePublishCopies('{"posts":[{"id":9,"title":"x"}]}', new Set([1])).size).toBe(0);
    expect(parsePublishCopies("做不到", new Set([1])).size).toBe(0);
  });

  it("剥 think 块后仍能解析", () => {
    const map = parsePublishCopies('<think>嗯</think>{"posts":[{"id":1,"title":"钩子标题"}]}', new Set([1]));
    expect(map.get(1)?.title).toBe("钩子标题");
    expect(map.get(1)?.hashtags).toEqual([]);
  });

  it("角度与 CTA:菜单内保留,菜单外丢弃成没标,ctaType 只在有 cta 时保留", () => {
    const content = JSON.stringify({
      posts: [
        { id: 1, title: "A", angle: "pain", cta: "评论区聊聊你的做法", ctaType: "comment" },
        { id: 2, title: "B", angle: "clickbait", cta: "  ", ctaType: "comment" },
        { id: 3, title: "C", ctaType: "share" },
      ],
    });
    const map = parsePublishCopies(content, new Set([1, 2, 3]));
    expect(map.get(1)).toMatchObject({ angle: "pain", cta: "评论区聊聊你的做法", ctaType: "comment" });
    expect(map.get(2)?.angle).toBeUndefined();
    expect(map.get(2)?.cta).toBeUndefined();
    expect(map.get(3)?.ctaType).toBeUndefined(); // 没有 cta 正文,类型标签没意义
  });
});

describe("generatePublishCopies", () => {
  it("正常路径:中文提示词 + id 素材对", async () => {
    const chat: PublishChatFn = async (_llm, system, user) => {
      expect(system).toContain("短视频运营");
      expect(user).toContain("[1] 片名:半杯水都不渗");
      return '{"posts":[{"id":1,"title":"A","hashtags":["#x"],"description":"d"},{"id":2,"title":"B"}]}';
    };
    const map = await generatePublishCopies(SOURCES, true, LLM, chat);
    expect(map?.size).toBe(2);
  });

  it("英文素材走英文提示词", async () => {
    const chat: PublishChatFn = async (_llm, system) => {
      expect(system).toContain("social manager");
      return '{"posts":[{"id":1,"title":"A"}]}';
    };
    await generatePublishCopies(SOURCES, false, LLM, chat);
  });

  it("端点失败/解析为空 → fail-open null;上游取消上抛", async () => {
    expect(await generatePublishCopies(SOURCES, true, LLM, async () => { throw new Error("down"); })).toBeNull();
    expect(await generatePublishCopies(SOURCES, true, LLM, async () => "垃圾")).toBeNull();
    expect(await generatePublishCopies([], true, LLM, async () => "{}")).toBeNull();
    const ac = new AbortController();
    ac.abort();
    await expect(
      generatePublishCopies(SOURCES, true, LLM, async () => { throw new Error("aborted"); }, ac.signal)
    ).rejects.toThrow();
  });
});

describe("postTextFile", () => {
  it("标题+话题+简介三段,空段省略", () => {
    expect(postTextFile({ title: "T", hashtags: ["#a", "#b"], description: "D" })).toBe("T\n\n#a #b\n\nD\n");
    expect(postTextFile({ title: "T", hashtags: [], description: "" })).toBe("T\n");
  });

  it("CTA 缀在简介后一行;没简介时 CTA 独立成段", () => {
    expect(postTextFile({ title: "T", hashtags: [], description: "D", cta: "关注我下期拆解", ctaType: "follow" })).toBe(
      "T\n\nD\n关注我下期拆解\n"
    );
    expect(postTextFile({ title: "T", hashtags: [], description: "", cta: "收藏慢慢看" })).toBe("T\n\n收藏慢慢看\n");
  });
});
