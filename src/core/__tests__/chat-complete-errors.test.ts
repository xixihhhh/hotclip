/**
 * LLM 连接失败的报错必须可执行(issue #6):选了本地 Ollama 但没装/没启动的
 * 用户,只看到 fetch failed 是不知道下一步的——本地/云端要给不同的指引。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatComplete, MAX_TOKENS, RETRY_MAX_TOKENS } from "../highlight/detect";

const OLLAMA = { baseUrl: "http://localhost:11434/v1", apiKey: "", model: "qwen3:8b" };
const CLOUD = { baseUrl: "https://api.atlascloud.ai/v1", apiKey: "sk-x", model: "qwen/qwen3.5-flash" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chatComplete 连接失败指引", () => {
  it("本地端点连不上 → 指引安装/启动 Ollama 或换云端", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("fetch failed"); }));
    await expect(chatComplete(OLLAMA, "s", "u")).rejects.toThrow(/Ollama/);
    await expect(chatComplete(OLLAMA, "s", "u")).rejects.toThrow(/ollama\.com/);
  });

  it("云端端点连不上 → 指引查网络与 Base URL,不提 Ollama", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("fetch failed"); }));
    const err = (await chatComplete(CLOUD, "s", "u").catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("检查网络");
    expect(err.message).not.toContain("Ollama");
  });

  it("本地 404(模型没拉) → 附 ollama pull 命令", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("model not found", { status: 404 })));
    await expect(chatComplete(OLLAMA, "s", "u")).rejects.toThrow(/ollama pull qwen3:8b/);
  });

  it("云端 404 → 不附 ollama pull 提示", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no such model", { status: 404 })));
    const err = (await chatComplete(CLOUD, "s", "u").catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("HTTP 404");
    expect(err.message).not.toContain("ollama pull");
  });
});

/** 构造一条 OpenAI 兼容响应。 */
function chatResponse(message: Record<string, unknown>, finishReason = "stop"): Response {
  return new Response(JSON.stringify({ choices: [{ finish_reason: finishReason, message }] }), { status: 200 });
}

describe("chatComplete 空响应处理(issue #8)", () => {
  it("思考模型烧完预算(finish=length) → 换大预算重试并成功", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(chatResponse({ content: "", reasoning_content: "先想想…" }, "length"))
      .mockResolvedValueOnce(chatResponse({ content: '{"clips":[]}' }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(chatComplete(CLOUD, "s", "u")).resolves.toBe('{"clips":[]}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const budgets = fetchMock.mock.calls.map(
      (c) => (JSON.parse((c as [string, { body: string }])[1].body) as { max_tokens: number }).max_tokens
    );
    expect(budgets).toEqual([MAX_TOKENS, RETRY_MAX_TOKENS]);
  });

  it("两次都只有思考没有正文 → 指引换非思考模型", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => chatResponse({ content: "", reasoning_content: "想了很久" }, "length"))
    );
    const err = (await chatComplete(CLOUD, "s", "u").catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("未返回内容");
    expect(err.message).toContain("深度思考");
    expect(err.message).toContain("non-thinking");
  });

  it("正文被网关错放进 reasoning(正常收尾) → 直接取 reasoning,不重试", async () => {
    const fetchMock = vi.fn(async () => chatResponse({ content: "", reasoning: '{"clips":[]}' }, "stop"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(chatComplete(CLOUD, "s", "u")).resolves.toBe('{"clips":[]}');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("安全审查拦截(content_filter) → 提示换供应商或素材", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => chatResponse({ content: "" }, "content_filter")));
    const err = (await chatComplete(CLOUD, "s", "u").catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("安全审查");
  });

  it("重试自身报 HTTP 错 → 不覆盖「空响应」诊断", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(chatResponse({ content: "", reasoning_content: "…" }, "length"))
      .mockResolvedValueOnce(new Response("max_tokens too large", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const err = (await chatComplete(CLOUD, "s", "u").catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("未返回内容");
    expect(err.message).toContain("深度思考");
  });

  it("普通空响应(无思考轨迹) → 重试一次后给通用提示", async () => {
    const fetchMock = vi.fn(async () => chatResponse({ content: "" }));
    vi.stubGlobal("fetch", fetchMock);
    const err = (await chatComplete(CLOUD, "s", "u").catch((e: unknown) => e)) as Error;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(err.message).toContain("空内容");
    expect(err.message).not.toContain("深度思考");
  });
});
