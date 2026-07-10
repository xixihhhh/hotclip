/**
 * HotClip MCP Server 入口(stdio):
 *   npx tsx src/mcp/server.ts
 * 在 Claude Code / Claude Desktop 里注册后,Agent 可直接调用本地切片管线
 * (转写/找爆点/出片全在本机,素材不出电脑)。协议逻辑见 protocol.ts。
 *
 * LLM 配置走环境变量:HOTCLIP_LLM_BASE_URL / HOTCLIP_LLM_MODEL /
 * HOTCLIP_LLM_API_KEY(本地 Ollama 端点可省 key)。
 * 模型与转写缓存目录与桌面 App 共享(下载一次两边都能用)。
 */
import { createInterface } from "readline";
import { homedir } from "os";
import { join, dirname, basename, extname } from "path";
import { stat } from "fs/promises";
import type { LlmConfig, Transcript } from "../shared/api-types";
import { SenseVoiceEngine } from "../core/transcribe/sensevoice";
import { readTranscriptCache, writeTranscriptCache } from "../core/transcribe/cache";
import { detectHighlights } from "../core/highlight/detect";
import { collectSignals } from "../core/signals";
import { collectEmotionSignal } from "../core/emotion";
import { exportClips, sanitizeFilename } from "../core/export";
import { sliceWords } from "../core/subtitle";
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

async function ensureFile(videoPath: string): Promise<{ size: number; mtimeMs: number }> {
  try {
    const s = await stat(videoPath);
    if (!s.isFile()) throw new Error("不是文件");
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    throw new Error(`文件不存在或不可读: ${videoPath}`);
  }
}

/** 转写(带缓存):SenseVoice 端侧,首次自动下载模型。 */
async function transcribe(videoPath: string): Promise<Transcript> {
  const fileStat = await ensureFile(videoPath);
  const cached = await readTranscriptCache(cacheDir(), videoPath, fileStat, "sensevoice");
  if (cached) return cached;
  const engine = new SenseVoiceEngine(modelsRoot());
  const t = await engine.transcribe(videoPath);
  await writeTranscriptCache(cacheDir(), videoPath, fileStat, "sensevoice", t).catch(() => {});
  return t;
}

function clampClips(n: unknown, fallback = 6): number {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(1, Math.min(12, Math.round(v))) : fallback;
}

async function detect(videoPath: string, maxClips: number): Promise<{ transcript: Transcript; candidates: Awaited<ReturnType<typeof detectHighlights>>["candidates"] }> {
  const llm = llmFromEnv();
  const transcript = await transcribe(videoPath);
  if (transcript.segments.length === 0) throw new Error("转写结果为空(可能是无人声素材)");
  // 视听信号 + 表情峰值:与桌面端同款证据链,全部 fail-open
  const signals = await collectSignals(videoPath).catch(() => undefined);
  const emotion = await collectEmotionSignal({
    videoPath,
    durationSec: transcript.durationSec,
    modelsRoot: modelsRoot(),
    signals,
  }).catch(() => null);
  const merged = emotion ? { loudPeaks: [], cutDense: [], ...signals, emotionPeaks: emotion.emotionPeaks } : signals;
  const outcome = await detectHighlights(transcript, llm, undefined, merged);
  return { transcript, candidates: outcome.candidates.slice(0, maxClips) };
}

function fmtClock(sec: number): string {
  const m = Math.floor(sec / 60);
  return `${String(m).padStart(2, "0")}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
}

/** 工具实现:返回给 Agent 的文本。 */
async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  const videoPath = String(args.videoPath);
  if (name === "transcribe_video") {
    const t = await transcribe(videoPath);
    const lines = t.segments.map((s) => `[${fmtClock(s.startSec)}] ${s.text}`).join("\n");
    const capped = lines.length > 60_000 ? `${lines.slice(0, 60_000)}\n…(截断)` : lines;
    return `语言:${t.language} 时长:${fmtClock(t.durationSec)} 共 ${t.segments.length} 句\n${capped}`;
  }

  if (name === "detect_highlights") {
    const { candidates } = await detect(videoPath, clampClips(args.maxClips));
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
    const { transcript, candidates } = await detect(videoPath, clampClips(args.maxClips));
    const publishable = candidates.filter((c) => c.recommended);
    if (publishable.length === 0) return "AI 复评后没有建议发布的切片(候选都被判定为弱钩子)。可用 detect_highlights 查看全部候选与复评意见。";
    const vertical = args.vertical !== false;
    const captions = args.captions !== false;
    const outDir =
      typeof args.outDir === "string" && args.outDir.trim()
        ? args.outDir
        : join(dirname(videoPath), `${sanitizeFilename(basename(videoPath, extname(videoPath)), "video")}-hotclip`);
    const results = await exportClips(
      videoPath,
      publishable.map((c) => ({
        id: c.id,
        title: c.title,
        startSec: c.startSec,
        endSec: c.endSec,
        words: captions ? sliceWords(transcript, c.startSec, c.endSec) : undefined,
        keywords: c.keywords,
        meta: { hook: c.hook, score: c.score, reason: c.reason, text: c.text, recommended: c.recommended, reviewNote: c.reviewNote },
      })),
      outDir,
      {
        vertical,
        captionStyle: captions ? "karaoke" : undefined,
        jumpCut: true,
        cleanFillers: true,
        titleCard: true,
        normalizeLoudness: true,
        faceTrack: vertical,
        snapToShots: true,
        modelsRoot: modelsRoot(),
        fontsDir: join(process.cwd(), "resources", "fonts"),
      }
    );
    const list = results
      .map((r) => {
        const c = publishable.find((x) => x.id === r.id);
        return `- ${basename(r.path)} (${Math.round(r.durationSec)}s, 评分 ${c?.score ?? "?"}) ${c?.title ?? ""}`;
      })
      .join("\n");
    return `已导出 ${results.length} 条切片到 ${outDir}\n${list}\n附带 clips.json(标题/评分/时间码/回执)与每条封面 JPG。`;
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
