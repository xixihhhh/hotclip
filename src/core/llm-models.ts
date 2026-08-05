/**
 * 拉取某个 OpenAI 兼容端点当前真正提供的模型清单(GET {baseUrl}/models)。
 *
 * 为什么要有:模型 id 是会烂的——厂商几个月就换一代(deepseek-chat 已于
 * 2026-07-24 下线,换成 deepseek-v4-*),写死在预设里的名字迟早 404。base_url
 * 基本不变,`/models` 也是 OpenAI 兼容协议里最稳的一个接口,所以让用户一键
 * 拉真实清单,比我们猜一个名字靠谱得多。
 *
 * 不是所有端点都实现了 /models(智谱这类自定义路径的尤其可能没有),
 * 拉不到就返回空清单 + 原因,UI 退回手填——绝不因此挡住用户跑检测。
 */

import type { ModelListResult } from "../shared/api-types";

export type { ModelListResult };

/** 清单上限:聚合平台(OpenRouter/硅基流动)动辄几百个,截断防止撑爆下拉。 */
export const MODEL_LIST_MAX = 400;
/** 拉取超时:这是个交互按钮,不能让用户干等。 */
export const MODEL_LIST_TIMEOUT_MS = 12_000;

/** 从各家 /models 响应里挖出 id 列表——OpenAI 是 {data:[{id}]},个别家直接给数组。 */
export function parseModelIds(body: unknown): string[] {
  const rows = Array.isArray(body)
    ? body
    : Array.isArray((body as { data?: unknown })?.data)
      ? ((body as { data: unknown[] }).data)
      : Array.isArray((body as { models?: unknown })?.models)
        ? ((body as { models: unknown[] }).models)
        : [];
  const ids = new Set<string>();
  for (const r of rows) {
    const id = typeof r === "string" ? r : typeof r === "object" && r !== null ? (r as { id?: unknown }).id : null;
    if (typeof id === "string" && id.trim()) ids.add(id.trim());
  }
  return [...ids].sort((a, b) => a.localeCompare(b)).slice(0, MODEL_LIST_MAX);
}

/**
 * 拉清单。fail-open:任何失败都返回 {ids: [], error} 而不是抛异常——
 * 这只是个填表帮手,不该有能力打断任何流程。
 */
export async function listModels(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<ModelListResult> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const timer = AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: signal ? AbortSignal.any([signal, timer]) : timer,
    });
    const text = await res.text();
    if (!res.ok) {
      return { ids: [], error: `HTTP ${res.status}: ${text.slice(0, 160)}` };
    }
    const ids = parseModelIds(JSON.parse(text));
    return ids.length > 0
      ? { ids, error: null }
      : { ids: [], error: "该端点没有返回模型清单 / endpoint returned no models" };
  } catch (e) {
    return { ids: [], error: e instanceof Error ? e.message : String(e) };
  }
}
