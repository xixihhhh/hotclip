/**
 * LLM 连接失败的报错必须可执行(issue #6):选了本地 Ollama 但没装/没启动的
 * 用户,只看到 fetch failed 是不知道下一步的——本地/云端要给不同的指引。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatComplete } from "../highlight/detect";

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
