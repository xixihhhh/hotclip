/**
 * Atlas Cloud 生成式媒体客户端(v0.14 云端档):图像/音乐生成的提交-轮询-
 * 下载三步,AI 封面与 AI BGM 共用。复用用户已配置的 LLM 档 Key——LLM
 * baseUrl 指向 Atlas 时才可用,零新增配置面(与云端视觉复核同一策略)。
 *
 * API 口径(2026-08 从 Atlas 文档核对):
 *   POST {origin}/api/v1/model/generateImage|generateAudio → {code,data:{id}}
 *   GET  {origin}/api/v1/model/prediction/{id} 轮询到 completed → outputs:[url]
 *   (部分模型文档写 result/{id}——两条都试,先 prediction 后 result)
 * 纯 fetch 实现,超时/取消经 AbortSignal;失败抛错由调用方 fail-open。
 */

/** 轮询间隔与总预算:图像 5-20s、音乐 30-90s 常见,预算给足由上层裁。 */
const POLL_INTERVAL_MS = 2_000;

/**
 * 从 LLM baseUrl 推导 Atlas 生成媒体 API 根(…/api/v1/model)。
 * 只认 Atlas 域——其他端点(本地 Ollama/别家云)没有这套生成 API,返回
 * null 表示「AI 生成档不可用」,上层据此禁用入口或静默跳过。
 */
export function atlasMediaBase(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null;
  try {
    const u = new URL(baseUrl);
    if (!/(^|\.)atlascloud\.ai$/i.test(u.hostname)) return null;
    return `${u.origin}/api/v1/model`;
  } catch {
    return null;
  }
}

interface SubmitResponse {
  code?: number;
  data?: { id?: string };
  /** 某些错误形态直接平铺 message。 */
  message?: string;
}

interface PredictionResponse {
  code?: number;
  data?: { status?: string; outputs?: string[]; error?: string };
  /** 兼容平铺形态(文档输出 schema 是平铺的)。 */
  status?: string;
  outputs?: string[];
}

/** 从两种响应形态里取任务状态与产物(文档与网关实现存在包一层/不包的分歧)。 */
function readPrediction(json: PredictionResponse): { status: string; outputs: string[] } {
  const status = (json.data?.status ?? json.status ?? "").toLowerCase();
  const outputs = json.data?.outputs ?? json.outputs ?? [];
  return { status, outputs };
}

/**
 * 提交生成任务并轮询到产物 URL。kind 对应 Atlas 的两个生成端点;
 * body 里必须带 model 与该模型要求的参数。任何失败(超时/网关错/任务
 * failed/无产物)一律抛错——调用方决定 fail-open 还是提示用户。
 */
export async function generateMedia(
  kind: "generateImage" | "generateAudio",
  body: Record<string, unknown>,
  opts: { mediaBase: string; apiKey: string; timeoutMs: number; signal?: AbortSignal; pollMs?: number }
): Promise<string> {
  const { mediaBase, apiKey, timeoutMs, signal, pollMs = POLL_INTERVAL_MS } = opts;
  const deadline = Date.now() + timeoutMs;
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  const timeboxed = (): AbortSignal => {
    const t = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    return signal ? AbortSignal.any([signal, t]) : t;
  };

  const submitRes = await fetch(`${mediaBase}/${kind}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: timeboxed(),
  });
  if (!submitRes.ok) throw new Error(`atlas ${kind} submit HTTP ${submitRes.status}`);
  const submitted = (await submitRes.json()) as SubmitResponse;
  const id = submitted.data?.id;
  if (!id) throw new Error(`atlas ${kind} submit: no prediction id (${submitted.message ?? "unknown"})`);

  // 轮询:文档在 prediction/{id} 与 result/{id} 间摇摆,先 prediction,
  // 404 时切 result 并在本次任务内记住(不是每轮都试两条)
  let path = "prediction";
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("cancelled");
    await new Promise((r) => setTimeout(r, pollMs));
    const res = await fetch(`${mediaBase}/${path}/${id}`, { headers, signal: timeboxed() });
    if (res.status === 404 && path === "prediction") {
      path = "result";
      continue;
    }
    if (!res.ok) throw new Error(`atlas poll HTTP ${res.status}`);
    const { status, outputs } = readPrediction((await res.json()) as PredictionResponse);
    if (status === "failed") throw new Error("atlas generation failed");
    if ((status === "completed" || status === "succeeded") && outputs.length > 0) return outputs[0];
  }
  throw new Error(`atlas ${kind} timed out after ${timeoutMs}ms`);
}

/** 把产物 URL 下载到本地文件;调用方负责目录存在与命名。 */
export async function downloadMedia(url: string, destPath: string, signal?: AbortSignal): Promise<void> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error("download: empty body");
  const { writeFile } = await import("fs/promises");
  await writeFile(destPath, buf);
}
