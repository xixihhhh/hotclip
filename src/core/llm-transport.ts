/** 模型 HTTP 请求的边界：总时限、可取消等待、有限重试和响应体上限。 */
export const LLM_REMOTE_TIMEOUT_MS = 180_000;
export const LLM_LOCAL_TIMEOUT_MS = 300_000;
export const LLM_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
export const LLM_RETRY_WAIT_MAX_MS = 5_000;

/** Kimi fixes temperature by model and thinking mode. Omit it to use the provider default. */
export function chatTemperature(model: string, preferred: number): number | undefined {
  return /(?:^|\/)kimi(?=$|[-.:_\s\d])/i.test(model) ? undefined : preferred;
}

export interface LlmRequestBudget { deadline: number; retriesRemaining: number }
export function llmRequestBudget(timeoutMs: number, retries = 0): LlmRequestBudget {
  return { deadline: Date.now() + timeoutMs, retriesRemaining: retries };
}

export class LlmTransportError extends Error {
  constructor(readonly kind: "timeout" | "response-too-large") {
    super(kind === "timeout"
      ? "模型响应超时，请稍后重试或选择更小的模型。/ Model response timed out; retry later or choose a smaller model."
      : "模型响应过大，已停止读取；请检查接口地址或换一个模型。/ Model response too large; check the endpoint or choose another model.");
    this.name = "LlmTransportError";
  }
}

/** Retry-After 同时支持秒数与 HTTP 日期；非法值不作为服务端等待指示。 */
export function retryAfterMs(value: string | null, now = Date.now()): number | null {
  if (!value?.trim()) return null;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const ms = Number(value) * 1000;
    return Number.isFinite(ms) ? ms : null;
  }
  // 避免 Date.parse 把负数或畸形数字解释成日期。
  if (!/[A-Za-z]/.test(value)) return null;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = (): void => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function readBounded(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const reader = response.body?.getReader();
  if (!reader) return "";
  const cancel = (): void => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  let complete = false;
  try {
    const declared = Number(response.headers.get("content-length"));
    if (declared > maxBytes) throw new LlmTransportError("response-too-large");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) { complete = true; break; }
      size += value.byteLength;
      if (size > maxBytes) throw new LlmTransportError("response-too-large");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

/** 只对明确的限流/暂时不可用响应重试；断网、超时和已成功返回的正文不重发。 */
export async function requestLlmText(url: string, init: Omit<RequestInit, "signal">, options: {
  signal?: AbortSignal; budget?: LlmRequestBudget; maxBytes?: number;
} = {}): Promise<{ ok: boolean; status: number; headers: Headers; text: string }> {
  const budget = options.budget ?? llmRequestBudget(LLM_REMOTE_TIMEOUT_MS);
  const timeout = new AbortController();
  const remaining = budget.deadline - Date.now();
  options.signal?.throwIfAborted();
  if (remaining <= 0) throw new LlmTransportError("timeout");
  const timer = setTimeout(() => timeout.abort(), remaining);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
  try {
    for (;;) {
      signal.throwIfAborted();
      const response = await fetch(url, { ...init, signal });
      const text = await readBounded(response, response.ok ? options.maxBytes ?? LLM_RESPONSE_MAX_BYTES : 64 * 1024, signal);
      const wait = retryAfterMs(response.headers.get("retry-after")) ?? 1_000;
      const quotaFailure = /insufficient_quota|quota_exhausted|billing_hard_limit|credit[_ ]balance|余额不足|欠费/i.test(text);
      if ((response.status === 429 || response.status === 503) && !quotaFailure && budget.retriesRemaining > 0 &&
          wait <= LLM_RETRY_WAIT_MAX_MS && wait < budget.deadline - Date.now()) {
        budget.retriesRemaining--;
        await waitForRetry(wait, signal);
        continue;
      }
      return { ok: response.ok, status: response.status, headers: response.headers, text };
    }
  } catch (error) {
    options.signal?.throwIfAborted();
    if (timeout.signal.aborted) throw new LlmTransportError("timeout");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** 对用户保留服务端诊断，但不把供应商回显的 Key 带进错误提示。 */
export function modelErrorDetail(text: string, apiKey: string, maxLength = 300): string {
  let detail = text;
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    const message = typeof body?.error === "string" ? body.error : body?.error?.message ?? body?.message;
    if (typeof message === "string") detail = message;
  } catch { /* 非 JSON 错误仍保留有界诊断。 */ }
  if (apiKey) detail = detail.split(apiKey).join("[redacted]");
  return detail.replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer [redacted]").slice(0, maxLength);
}
