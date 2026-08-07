/**
 * LLM 配置预检判定(issue #6):三类必败局要拦准,其余一律放行——
 * fail-open 是底线,预检永远不能拦住一套本来能跑的配置。
 */
import { describe, expect, it } from "vitest";
import { preflightVerdict, isLocalBaseUrl } from "../../shared/llm-preflight";

const OLLAMA = "http://localhost:11434/v1";
const CLOUD = "https://api.atlascloud.ai/v1";

describe("isLocalBaseUrl", () => {
  it("localhost 与 127.0.0.1 算本地,云端域名不算", () => {
    expect(isLocalBaseUrl(OLLAMA)).toBe(true);
    expect(isLocalBaseUrl("http://127.0.0.1:1234/v1")).toBe(true);
    expect(isLocalBaseUrl(CLOUD)).toBe(false);
  });
});

describe("preflightVerdict", () => {
  it("本地连不上 → local-down(Ollama 没装/没启动)", () => {
    expect(preflightVerdict({ ids: [], error: "fetch failed" }, OLLAMA, "qwen3:8b")).toEqual({ kind: "local-down" });
    expect(preflightVerdict({ ids: [], error: "connect ECONNREFUSED 127.0.0.1:11434" }, OLLAMA, "qwen3:8b")).toEqual({
      kind: "local-down",
    });
  });

  it("云端连不上 → unreachable(网络/地址问题)", () => {
    expect(preflightVerdict({ ids: [], error: "fetch failed" }, CLOUD, "m")).toEqual({ kind: "unreachable" });
    expect(preflightVerdict({ ids: [], error: "The operation was aborted due to timeout" }, CLOUD, "m")).toEqual({
      kind: "unreachable",
    });
  });

  it("HTTP 401/403 → auth(Key 空/错/过期)", () => {
    expect(preflightVerdict({ ids: [], error: "HTTP 401: invalid api key" }, CLOUD, "m")).toEqual({ kind: "auth" });
    expect(preflightVerdict({ ids: [], error: "HTTP 403: forbidden" }, CLOUD, "m")).toEqual({ kind: "auth" });
  });

  it("端点没实现 /models(404/空清单) → unknown,放行", () => {
    expect(preflightVerdict({ ids: [], error: "HTTP 404: not found" }, CLOUD, "m")).toEqual({ kind: "unknown" });
    expect(
      preflightVerdict({ ids: [], error: "该端点没有返回模型清单 / endpoint returned no models" }, CLOUD, "m")
    ).toEqual({ kind: "unknown" });
  });

  it("本地模型没拉 → model-missing 并附已装清单", () => {
    const res = { ids: ["llama3:latest", "qwen2:7b"], error: null };
    expect(preflightVerdict(res, OLLAMA, "qwen3:8b")).toEqual({
      kind: "model-missing",
      installed: ["llama3:latest", "qwen2:7b"],
    });
  });

  it("Ollama 省略 :latest 标签也算命中", () => {
    const res = { ids: ["llama3:latest"], error: null };
    expect(preflightVerdict(res, OLLAMA, "llama3")).toEqual({ kind: "ok" });
  });

  it("本地模型在清单里 → ok", () => {
    expect(preflightVerdict({ ids: ["qwen3:8b"], error: null }, OLLAMA, "qwen3:8b")).toEqual({ kind: "ok" });
  });

  it("云端清单可能不全,不据此拦人 → 模型不在清单也 ok", () => {
    expect(preflightVerdict({ ids: ["other-model"], error: null }, CLOUD, "my-model")).toEqual({ kind: "ok" });
  });
});
