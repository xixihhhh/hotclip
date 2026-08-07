/**
 * LLM 配置预检(issue #6 的产品级答案):用户点「开始」之前,拿 OpenAI 兼容
 * 协议里最稳的 /models 接口先探一次路——「本地 Ollama 没装/没启动」「Key
 * 空/错」「本地模型没拉取」这三类必败局,在配置面板里就拦下并告诉用户怎么
 * 办,而不是等检测跑到一半才甩一句 fetch failed。
 * fail-open 是底线:探针说不清的(端点没实现 /models 等)一律放行,预检
 * 永远不能拦住一套本来能跑的配置。纯函数,渲染层与测试共用。
 */
import type { ModelListResult } from "./api-types";

export type PreflightVerdict =
  | { kind: "ok" }
  /** 探针自身说不清(端点没实现 /models 等)——放行。 */
  | { kind: "unknown" }
  /** 本地端点没响应:Ollama 没装/没启动。 */
  | { kind: "local-down" }
  /** 云端端点连不上:网络或接口地址问题。 */
  | { kind: "unreachable" }
  /** 鉴权失败:API Key 空/错/过期。 */
  | { kind: "auth" }
  /** 本地服务在跑,但所填模型还没拉取;附上已安装清单方便就地改选。 */
  | { kind: "model-missing"; installed: string[] };

/** 本地端点(Ollama/LM Studio 等):不需要 Key,但需要服务真的在本机跑着。 */
export function isLocalBaseUrl(baseUrl: string): boolean {
  return /localhost|127\.0\.0\.1/.test(baseUrl);
}

/** 连接类失败的错误特征(undici 的 fetch failed、系统级 ECONNREFUSED、超时)。 */
const CONNECT_FAIL = /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|abort|timeout|network/i;

/** Ollama 允许省略 :latest 标签——"llama3" 命中已安装的 "llama3:latest"。 */
function hasModel(ids: string[], model: string): boolean {
  return ids.includes(model) || ids.includes(`${model}:latest`);
}

export function preflightVerdict(res: ModelListResult, baseUrl: string, model: string): PreflightVerdict {
  const local = isLocalBaseUrl(baseUrl);
  if (res.error) {
    if (CONNECT_FAIL.test(res.error)) return local ? { kind: "local-down" } : { kind: "unreachable" };
    if (/^HTTP (401|403)/.test(res.error)) return { kind: "auth" };
    // 其余(404 没实现 /models、返回空清单、解析失败)都不是 chat 必败的证据
    return { kind: "unknown" };
  }
  // 本地清单是确定性的(Ollama 列的就是已安装全集);云端清单可能不全,不据此拦人
  if (local && res.ids.length > 0 && !hasModel(res.ids, model)) {
    return { kind: "model-missing", installed: res.ids };
  }
  return { kind: "ok" };
}
