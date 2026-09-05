/**
 * HotClip MCP 协议层(stdio JSON-RPC 2.0,零依赖手写):
 * 「本地 MCP 切片器」——让 Claude 等 Agent 直接驱动本地切片管线:
 * "给我这个 4 小时录播,切 10 条爆点" → 转写/检测/出片全在用户机器上跑。
 *
 * 只实现 MCP 需要的最小面:initialize / tools/list / tools/call / ping。
 * 本文件是纯逻辑(消息进→响应出,工具执行通过注入),可完整单测;
 * stdin/stdout 与真实管线在 server.ts。
 */

import { describeSubtitleImportError } from "../shared/subtitle-import";

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
      "全托管切片:把一个本地长视频(播客/直播回放/课程)转写、AI 找爆点并导出为可发布的竖屏短视频(烧字幕/跳剪/表情信号),返回输出目录与每条切片的标题/评分/时间码。未提供 subtitlePath 时,首次运行会自动下载本地 ASR 模型。需要环境变量 HOTCLIP_LLM_BASE_URL/HOTCLIP_LLM_MODEL(以及非本地端点的 HOTCLIP_LLM_API_KEY)。",
    inputSchema: {
      type: "object",
      properties: {
        videoPath: { type: "string", description: "本地视频文件的绝对路径" },
        engineId: { type: "string", enum: ["sensevoice", "paraformer", "fireredasr", "qwen3"], description: "本地 ASR 引擎，默认 sensevoice；qwen3 需要单独启动本地语音服务。" },
        localServiceUrl: { type: "string", description: "Qwen3 本地服务地址，仅 127.0.0.1 / ::1，默认 http://127.0.0.1:8766。" },
        restart: { type: "boolean", description: "重新转写，不复用本次素材的当前引擎分段进度；默认自动续跑。" },
        subtitlePath: { type: "string", description: "可选:与当前素材对齐的 UTF-8 SRT/WebVTT 单轨原文字幕绝对路径(最大 5 MB、无重叠)。跳过 ASR,保留原句时间;句内字词时间为估算,需复核。" },
        maxClips: { type: "number", description: "最多导出几条(1-12,默认 6)" },
        vertical: { type: "boolean", description: "竖屏 9:16 输出(默认 true)" },
        captions: { type: "boolean", description: "烧录动态字幕(默认 true)" },
        autoEnhance: { type: "boolean", description: "本地测量最终保留画面并克制修正明显偏暗/灰/过饱和素材(默认 false;不下载模型)" },
        denoiseMode: { type: "string", enum: ["basic", "smart"], description: "可选音频清理:basic 固定滤镜;smart 48kHz 本地人声模型(失败自动回退 basic)" },
        outDir: { type: "string", description: "输出目录(默认源视频旁 <名>-hotclip/)" },
        referencePath: { type: "string", description: "对标爆款视频的本地路径(可选):实测其时长/语速/句长/镜头频率/钩子形态,选段向对标节奏靠拢(偏好不是硬约束);分析失败按无参考继续" },
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
        engineId: { type: "string", enum: ["sensevoice", "paraformer", "fireredasr", "qwen3"], description: "本地 ASR 引擎，默认 sensevoice；qwen3 需要单独启动本地语音服务。" },
        localServiceUrl: { type: "string", description: "Qwen3 本地服务地址，仅 127.0.0.1 / ::1，默认 http://127.0.0.1:8766。" },
        restart: { type: "boolean", description: "重新转写，不复用本次素材的当前引擎分段进度；默认自动续跑。" },
        subtitlePath: { type: "string", description: "可选:与当前素材对齐的 UTF-8 SRT/WebVTT 单轨原文字幕绝对路径(最大 5 MB、无重叠)。跳过 ASR,保留原句时间;句内字词时间为估算,需复核。" },
        maxClips: { type: "number", description: "最多几条候选(1-12,默认 6)" },
        referencePath: { type: "string", description: "对标爆款视频的本地路径(可选):实测其节奏画像,候选向对标节奏靠拢;分析失败按无参考继续" },
      },
      required: ["videoPath"],
    },
  },
  {
    name: "transcribe_video",
    description:
      "字幕接入或本地转写:提供 subtitlePath 时导入已有字幕并估算字词时间;否则用端侧 ASR(SenseVoice,首次自动下载)把视频/音频转成带时间戳的逐句稿。结果有缓存,同一文件二次调用秒回。不需要 LLM 配置。",
    inputSchema: {
      type: "object",
      properties: {
        videoPath: { type: "string", description: "本地视频/音频文件的绝对路径" },
        engineId: { type: "string", enum: ["sensevoice", "paraformer", "fireredasr", "qwen3"], description: "本地 ASR 引擎，默认 sensevoice；qwen3 需要单独启动本地语音服务。" },
        localServiceUrl: { type: "string", description: "Qwen3 本地服务地址，仅 127.0.0.1 / ::1，默认 http://127.0.0.1:8766。" },
        restart: { type: "boolean", description: "重新转写，不复用本次素材的当前引擎分段进度；默认自动续跑。" },
        subtitlePath: { type: "string", description: "可选:导入已有 UTF-8 SRT/WebVTT 原文字幕,跳过 ASR(最大 5 MB、无重叠)。句内字词时间为估算,需复核。" },
      },
      required: ["videoPath"],
    },
  },
];

/** 参数校验:必填与类型(浅校验够用——工具实现里还有业务检查)。 */
export function validateToolArgs(tool: McpToolDef, args: Record<string, unknown>): string | null {
  const schema = tool.inputSchema as { properties?: Record<string, { type?: string; enum?: unknown[] }>; required?: string[] };
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
    if (spec.enum && !spec.enum.includes(value)) return `参数 ${key} 应为 ${spec.enum.join("|")}`;
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
        return result(msg.id, toolText(describeSubtitleImportError(e), true));
      }
    }
    default:
      return rpcError(msg.id, -32601, `method not found: ${method}`);
  }
}
