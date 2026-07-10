import { describe, it, expect } from "vitest";
import {
  handleMcpMessage,
  validateToolArgs,
  MCP_TOOLS,
  MCP_PROTOCOL_VERSION,
  type ToolExecutor,
} from "../../mcp/protocol";

const noop: ToolExecutor = async () => "ok";

describe("handleMcpMessage", () => {
  it("initialize 返回协议版本/能力/服务信息", async () => {
    const res = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, noop, "0.5.0");
    const r = res as { id: number; result: { protocolVersion: string; capabilities: { tools: object }; serverInfo: { name: string } } };
    expect(r.id).toBe(1);
    expect(r.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(r.result.capabilities.tools).toBeDefined();
    expect(r.result.serverInfo.name).toBe("hotclip");
  });

  it("notifications/initialized 不产生响应", async () => {
    expect(await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, noop, "0")).toBeNull();
  });

  it("tools/list 列出三个工具且带 schema", async () => {
    const res = await handleMcpMessage({ id: 2, method: "tools/list" }, noop, "0");
    const tools = (res as { result: { tools: typeof MCP_TOOLS } }).result.tools;
    expect(tools.map((t) => t.name)).toEqual(["clip_video", "detect_highlights", "transcribe_video"]);
    for (const t of tools) expect(t.inputSchema).toHaveProperty("properties");
  });

  it("tools/call 正常路径返回 content 文本", async () => {
    const exec: ToolExecutor = async (name, args) => `${name}:${args.videoPath}`;
    const res = await handleMcpMessage(
      { id: 3, method: "tools/call", params: { name: "transcribe_video", arguments: { videoPath: "/v.mp4" } } },
      exec,
      "0"
    );
    const r = res as { result: { content: Array<{ type: string; text: string }>; isError?: boolean } };
    expect(r.result.content[0].text).toBe("transcribe_video:/v.mp4");
    expect(r.result.isError).toBeUndefined();
  });

  it("缺必填参数 → isError 而非协议错误", async () => {
    const res = await handleMcpMessage(
      { id: 4, method: "tools/call", params: { name: "clip_video", arguments: {} } },
      noop,
      "0"
    );
    const r = res as { result: { content: Array<{ text: string }>; isError: boolean } };
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("videoPath");
  });

  it("未知工具/执行抛错 → isError,消息透传", async () => {
    const unknown = await handleMcpMessage({ id: 5, method: "tools/call", params: { name: "nope", arguments: {} } }, noop, "0");
    expect((unknown as { result: { isError: boolean } }).result.isError).toBe(true);
    const boom: ToolExecutor = async () => { throw new Error("文件不存在或不可读: /x.mp4"); };
    const res = await handleMcpMessage(
      { id: 6, method: "tools/call", params: { name: "transcribe_video", arguments: { videoPath: "/x.mp4" } } },
      boom,
      "0"
    );
    const r = res as { result: { content: Array<{ text: string }>; isError: boolean } };
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("文件不存在");
  });

  it("未知方法 → -32601;ping → 空结果", async () => {
    const res = await handleMcpMessage({ id: 7, method: "resources/list" }, noop, "0");
    expect((res as { error: { code: number } }).error.code).toBe(-32601);
    const pong = await handleMcpMessage({ id: 8, method: "ping" }, noop, "0");
    expect((pong as { result: object }).result).toEqual({});
  });
});

describe("validateToolArgs", () => {
  const tool = MCP_TOOLS[0]; // clip_video

  it("类型不匹配报具体参数名", () => {
    expect(validateToolArgs(tool, { videoPath: "/v.mp4", maxClips: "six" })).toContain("maxClips");
    expect(validateToolArgs(tool, { videoPath: "/v.mp4", vertical: "yes" })).toContain("vertical");
  });

  it("合法参数通过", () => {
    expect(validateToolArgs(tool, { videoPath: "/v.mp4", maxClips: 8, vertical: false })).toBeNull();
  });
});
