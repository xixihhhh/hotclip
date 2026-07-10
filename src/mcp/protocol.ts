/**
 * HotClip MCP 协议层(stdio JSON-RPC 2.0,零依赖手写):
 * 「本地 MCP 切片器」——让 Claude 等 Agent 直接驱动本地切片管线:
 * "给我这个 4 小时录播,切 10 条爆点" → 转写/检测/出片全在用户机器上跑。
 *
 * 只实现 MCP 需要的最小面:initialize / tools/list / tools/call / ping。
 * 本文件是纯逻辑(消息进→响应出,工具执行通过注入),可完整单测;
 * stdin/stdout 与真实管线在 server.ts。
 */

/** MCP 协议版本(2024-11-05 基线,客户端普遍兼容)。 */
export const MCP_PROTOCOL_VERSION = "2024-11-05";

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** 工具执行注入点:返回给 Agent 的文本(抛错→isError 响应)。 */
export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<string>;

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: "clip_video",
    description:
      "全托管切片:把一个本地长视频(播客/直播回放/课程)转写、AI 找爆点并导出为可发布的竖屏短视频(烧字幕/跳剪/表情信号),返回输出目录与每条切片的标题/评分/时间码。首次运行会自动下载本地 ASR 模型。需要环境变量 HOTCLIP_LLM_BASE_URL/HOTCLIP_LLM_MODEL(以及非本地端点的 HOTCLIP_LLM_API_KEY)。",
    inputSchema: {
      type: "object",
      properties: {
        videoPath: { type: "string", description: "本地视频文件的绝对路径" },
        maxClips: { type: "number", description: "最多导出几条(1-12,默认 6)" },
        vertical: { type: "boolean", description: "竖屏 9:16 输出(默认 true)" },
        captions: { type: "boolean", description: "烧录卡拉OK字幕(默认 true)" },
        outDir: { type: "string", description: "输出目录(默认源视频旁 <名>-hotclip/)" },
      },
      required: ["videoPath"],
    },
  },
  {
    name: "detect_highlights",
    description:
      "只找爆点不出片:转写并用 LLM 挑出爆点候选,返回每条的时间码/标题/钩子/评分/理由/AI复评意见 JSON。适合先审后剪的流程。需要 HOTCLIP_LLM_* 环境变量。",
    inputSchema: {
      type: "object",
      properties: {
        videoPath: { type: "string", description: "本地视频文件的绝对路径" },
        maxClips: { type: "number", description: "最多几条候选(1-12,默认 6)" },
      },
      required: ["videoPath"],
    },
  },
  {
    name: "transcribe_video",
    description:
      "本地转写:用端侧 ASR(SenseVoice,首次自动下载)把视频/音频转成带时间戳的逐句稿。结果有缓存,同一文件二次调用秒回。不需要 LLM 配置。",
    inputSchema: {
      type: "object",
      properties: {
        videoPath: { type: "string", description: "本地视频/音频文件的绝对路径" },
      },
      required: ["videoPath"],
    },
  },
];

/** 参数校验:必填与类型(浅校验够用——工具实现里还有业务检查)。 */
export function validateToolArgs(tool: McpToolDef, args: Record<string, unknown>): string | null {
  const schema = tool.inputSchema as { properties?: Record<string, { type?: string }>; required?: string[] };
  for (const key of schema.required ?? []) {
    if (args[key] === undefined || args[key] === null || args[key] === "") return `缺少必填参数 ${key}`;
  }
  for (const [key, value] of Object.entries(args)) {
    const spec = schema.properties?.[key];
    if (!spec?.type || value === undefined) continue;
    const actual = typeof value;
    if (spec.type === "number" && actual !== "number") return `参数 ${key} 应为 number`;
    if (spec.type === "string" && actual !== "string") return `参数 ${key} 应为 string`;
    if (spec.type === "boolean" && actual !== "boolean") return `参数 ${key} 应为 boolean`;
  }
  return null;
}

function result(id: JsonRpcMessage["id"], payload: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, result: payload };
}

function rpcError(id: JsonRpcMessage["id"], code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function toolText(text: string, isError = false): Record<string, unknown> {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

/**
 * 处理一条 JSON-RPC 消息;返回响应对象,通知(无 id 的 notification)返回 null。
 */
export async function handleMcpMessage(
  msg: JsonRpcMessage,
  execute: ToolExecutor,
  serverVersion: string
): Promise<Record<string, unknown> | null> {
  const method = msg.method ?? "";
  // 通知不需要响应(initialized / cancelled 等)
  if (msg.id === undefined && method.startsWith("notifications/")) return null;

  switch (method) {
    case "initialize":
      return result(msg.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "hotclip", version: serverVersion },
      });
    case "ping":
      return result(msg.id, {});
    case "tools/list":
      return result(msg.id, { tools: MCP_TOOLS });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      const tool = MCP_TOOLS.find((t) => t.name === name);
      if (!tool) return result(msg.id, toolText(`未知工具: ${name}`, true));
      const invalid = validateToolArgs(tool, args);
      if (invalid) return result(msg.id, toolText(invalid, true));
      try {
        return result(msg.id, toolText(await execute(name, args)));
      } catch (e) {
        return result(msg.id, toolText(e instanceof Error ? e.message : String(e), true));
      }
    }
    default:
      return rpcError(msg.id, -32601, `method not found: ${method}`);
  }
}
