/**
 * HotClip MCP Server 入口(stdio):
 *   npx tsx src/mcp/server.ts
 * 在 Claude Code / Claude Desktop 里注册后,Agent 可直接调用本地切片管线
 * (转写/找爆点/出片全在本机,素材不出电脑)。协议逻辑见 protocol.ts,
 * 管线实现与桌面端/录播监听共用 core/pipeline.ts。
 *
 * LLM 配置走环境变量:HOTCLIP_LLM_BASE_URL / HOTCLIP_LLM_MODEL /
 * HOTCLIP_LLM_API_KEY(本地 Ollama 端点可省 key)。
 * 模型与转写缓存目录与桌面 App 共享(下载一次两边都能用)。
 */
import { createInterface } from "readline";
import { homedir } from "os";
import { join, basename } from "path";
import type { LlmConfig } from "../shared/api-types";
import { transcribeCached, detectForPipeline, autoClip } from "../core/pipeline";
import { loadGlossary } from "../core/glossary-store";
import { handleMcpMessage, type JsonRpcMessage } from "./protocol";

/** 与 Electron 的 app.getPath("userData") 同路径——模型/缓存两边共享。 */
export function userDataDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "hotclip");
  if (platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "hotclip");
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "hotclip");
}

const modelsRoot = (): string => join(userDataDir(), "models");
const cacheDir = (): string => join(userDataDir(), "transcript-cache");

/** LLM 配置来自环境变量;缺配置时给 Agent 一段能照做的指引。 */
function llmFromEnv(): LlmConfig {
  const baseUrl = process.env.HOTCLIP_LLM_BASE_URL ?? "";
  const model = process.env.HOTCLIP_LLM_MODEL ?? "";
  if (!baseUrl || !model) {
    throw new Error(
      "缺少 LLM 配置:请在 MCP server 的 env 里设置 HOTCLIP_LLM_BASE_URL 与 HOTCLIP_LLM_MODEL(OpenAI 兼容端点;本地 Ollama 为 http://localhost:11434/v1,免 key;云端另需 HOTCLIP_LLM_API_KEY)"
    );
  }
  return { baseUrl, apiKey: process.env.HOTCLIP_LLM_API_KEY ?? "ollama", model };
}

function fmtClock(sec: number): string {
  const m = Math.floor(sec / 60);
  return `${String(m).padStart(2, "0")}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
}

function clampClips(n: unknown): number | undefined {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(1, Math.min(12, Math.round(v))) : undefined;
}

/** 工具实现:返回给 Agent 的文本。 */
async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  const videoPath = String(args.videoPath);

  if (name === "transcribe_video") {
    const t = await transcribeCached(videoPath, modelsRoot(), cacheDir(), await loadGlossary(userDataDir()));
    const lines = t.segments.map((s) => `[${fmtClock(s.startSec)}] ${s.text}`).join("\n");
    const capped = lines.length > 60_000 ? `${lines.slice(0, 60_000)}\n…(截断)` : lines;
    return `语言:${t.language} 时长:${fmtClock(t.durationSec)} 共 ${t.segments.length} 句\n${capped}`;
  }

  if (name === "detect_highlights") {
    const llm = llmFromEnv();
    const transcript = await transcribeCached(videoPath, modelsRoot(), cacheDir(), await loadGlossary(userDataDir()));
    const candidates = await detectForPipeline(videoPath, transcript, {
      modelsRoot: modelsRoot(),
      llm,
      maxClips: clampClips(args.maxClips),
    });
    if (candidates.length === 0) return "没有找到值得切的爆点候选。";
    return JSON.stringify(
      candidates.map((c) => ({
        id: c.id,
        start: fmtClock(c.startSec),
        end: fmtClock(c.endSec),
        startSec: c.startSec,
        endSec: c.endSec,
        title: c.title,
        hook: c.hook,
        score: c.score,
        reason: c.reason,
        recommended: c.recommended,
        reviewNote: c.reviewNote || undefined,
      })),
      null,
      2
    );
  }

  if (name === "clip_video") {
    const llm = llmFromEnv();
    const outcome = await autoClip(videoPath, {
      modelsRoot: modelsRoot(),
      cacheDir: cacheDir(),
      llm,
      maxClips: clampClips(args.maxClips),
      vertical: args.vertical !== false,
      captions: args.captions !== false,
      outDir: typeof args.outDir === "string" && args.outDir.trim() ? args.outDir : undefined,
      fontsDir: join(process.cwd(), "resources", "fonts"),
      glossary: await loadGlossary(userDataDir()),
    });
    if (outcome.exported.length === 0) {
      return "AI 复评后没有建议发布的切片(候选都被判定为弱钩子)。可用 detect_highlights 查看全部候选与复评意见。";
    }
    const list = outcome.exported
      .map((r) => {
        const c = outcome.candidates.find((x) => x.id === r.id);
        return `- ${basename(r.path)} (${Math.round(r.durationSec)}s, 评分 ${c?.score ?? "?"}) ${c?.title ?? ""}`;
      })
      .join("\n");
    return `已导出 ${outcome.exported.length} 条切片到 ${outcome.outDir}\n${list}\n附带 clips.json(标题/评分/时间码/回执)与每条封面 JPG。`;
  }

  throw new Error(`未实现的工具: ${name}`);
}

// ---- stdio 主循环:一行一条 JSON-RPC ----
export function startServer(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const version = (require("../../package.json") as { version: string }).version;
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(text) as JsonRpcMessage;
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`);
      return;
    }
    void handleMcpMessage(msg, executeTool, version).then((res) => {
      if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
    });
  });
  process.stderr.write("hotclip mcp server ready (stdio)\n");
}

startServer();
