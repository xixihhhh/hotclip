/**
 * LLM 连接失败的报错必须可执行(issue #6):选了本地 Ollama 但没装/没启动的
 * 用户,只看到 fetch failed 是不知道下一步的——本地/云端要给不同的指引。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatComplete, MAX_TOKENS, RETRY_MAX_TOKENS, temperatureForModel, thinkingParams } from "../highlight/detect";

const OLLAMA = { baseUrl: "http://localhost:11434/v1", apiKey: "", model: "qwen3:8b" };
const CLOUD = { baseUrl: "https://api.atlascloud.ai/v1", apiKey: "sk-x", model: "qwen/qwen3.5-flash" };

afterEach(() => {
  vi.useRealTimers();
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

describe("chatComplete 请求恢复边界", () => {
  it("限流恢复和 Qwen 参数回退共用一次重试额度", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(new Response("unsupported parameter: enable_thinking", { status: 400 }))
      .mockResolvedValueOnce(new Response("busy again", { status: 503, headers: { "retry-after": "0" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(chatComplete(CLOUD, "s", "u")).rejects.toThrow("HTTP 503");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).enable_thinking)).toEqual([false, false, undefined]);
  });

  it("参数回退只使用首次请求剩余的时间", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => {
        vi.setSystemTime(Date.now() + 170_000);
        return new Response("unsupported parameter: enable_thinking", { status: 400 });
      })
      .mockImplementation((_url, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
      }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = chatComplete(CLOUD, "s", "u");
    const check = expect(pending).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(10_000);
    await check;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("服务端要求长等待时保留等待提示并隐藏回显 Key", async () => {
    const fetchMock = vi.fn(async () => new Response(`rate limited for ${CLOUD.apiKey}`, {
      status: 429, headers: { "retry-after": "120" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const error = await chatComplete(CLOUD, "s", "u").catch((e: Error) => e) as Error;
    expect(error.message).toContain("120 秒");
    expect(error.message).not.toContain(CLOUD.apiKey);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("空白正文仍可取回正常结束的 reasoning", async () => {
    const fetchMock = vi.fn(async () => chatResponse({ content: " \n ", reasoning: '{"clips":[]}' }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(chatComplete(CLOUD, "s", "u")).resolves.toBe('{"clips":[]}');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("chatComplete 空响应处理(issue #8)", () => {
  it("Qwen3 混合思考模型首请求关闭 thinking,避免正文预算被吃光", async () => {
    const fetchMock = vi.fn(async () => chatResponse({ content: '{"clips":[]}' }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(chatComplete({ ...CLOUD, model: "qwen3.5-flash" }, "s", "u")).resolves.toBe('{"clips":[]}');
    const body = JSON.parse(((fetchMock.mock.calls[0] as unknown) as [string, { body: string }])[1].body) as Record<string, unknown>;
    expect(body.enable_thinking).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("严格网关不认识 enable_thinking 时回退为标准请求", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("unsupported parameter: enable_thinking", { status: 400 }))
      .mockResolvedValueOnce(chatResponse({ content: '{"clips":[]}' }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(chatComplete({ ...CLOUD, model: "qwen3.5-flash" }, "s", "u")).resolves.toBe('{"clips":[]}');
    const firstBody = JSON.parse(((fetchMock.mock.calls[0] as unknown) as [string, { body: string }])[1].body) as Record<string, unknown>;
    const secondBody = JSON.parse(((fetchMock.mock.calls[1] as unknown) as [string, { body: string }])[1].body) as Record<string, unknown>;
    expect(firstBody.enable_thinking).toBe(false);
    expect(secondBody.enable_thinking).toBeUndefined();
  });

  it("兼容 OpenAI 多模态 content 数组和旧式 choices.text", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(chatResponse({ content: [{ type: "text", text: "{" }, { type: "text", text: '"clips":[]}' }] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(chatComplete(CLOUD, "s", "u")).resolves.toBe('{"clips":[]}');

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ text: "legacy" }] }), { status: 200 })));
    await expect(chatComplete(CLOUD, "s", "u")).resolves.toBe("legacy");
  });

  it("只给 Qwen/QwQ 注入关闭 thinking 参数", () => {
    expect(thinkingParams("qwen3.5-flash")).toEqual({ enable_thinking: false });
    expect(thinkingParams("Qwen/QwQ-32B")).toEqual({ enable_thinking: false });
    expect(thinkingParams("deepseek-v4-flash")).toEqual({});
  });

  it("Kimi models use the only accepted temperature while other models keep their defaults", () => {
    expect(temperatureForModel("moonshotai/kimi-k2.5")).toBe(1);
    expect(temperatureForModel("kimi-3.0", 0.2)).toBe(1);
    expect(temperatureForModel("qwen3.5-flash")).toBe(0.6);
    expect(temperatureForModel("qwen3-vl", 0.2)).toBe(0.2);
  });

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
