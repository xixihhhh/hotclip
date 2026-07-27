/**
 * Headless 运行环境(CLI 与 MCP Server 共用):不经 Electron 启动时的
 * 用户数据目录定位与 LLM 环境变量配置。路径与桌面端 app.getPath("userData")
 * 完全一致——模型/转写缓存/热词词表下载配置一次,桌面、CLI、MCP 三边共用。
 */
import { homedir } from "os";
import { join } from "path";
import type { LlmConfig } from "../shared/api-types";

/** 与 Electron 的 app.getPath("userData") 同路径——模型/缓存两边共享。 */
export function userDataDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "hotclip");
  if (platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "hotclip");
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "hotclip");
}

/** AI 模型根目录(转写/取景/镜头检测模型,首次自动下载)。 */
export const modelsRoot = (): string => join(userDataDir(), "models");

/** 转写结果本地缓存目录(同文件重开秒进)。 */
export const cacheDir = (): string => join(userDataDir(), "transcript-cache");

/**
 * 成片落地目录:<导出根目录>/<片名>/。
 * 根目录默认是系统「影片」下的 HotClip(新手在文件管理器里找得到),用户在
 * 界面上改过就以他选的为准(issue #3)。空串/空白一律视为「没选过」。
 */
export function clipOutDir(chosen: string | null | undefined, videosDir: string, sourceName: string): string {
  const root = typeof chosen === "string" && chosen.trim() ? chosen.trim() : join(videosDir, "HotClip");
  return join(root, sourceName);
}

/** LLM 配置来自环境变量;缺配置时给 Agent/用户一段能照做的指引。 */
export function llmFromEnv(): LlmConfig {
  const baseUrl = process.env.HOTCLIP_LLM_BASE_URL ?? "";
  const model = process.env.HOTCLIP_LLM_MODEL ?? "";
  if (!baseUrl || !model) {
    throw new Error(
      "缺少 LLM 配置:请设置环境变量 HOTCLIP_LLM_BASE_URL 与 HOTCLIP_LLM_MODEL(OpenAI 兼容端点;本地 Ollama 为 http://localhost:11434/v1,免 key;云端另需 HOTCLIP_LLM_API_KEY)"
    );
  }
  return { baseUrl, apiKey: process.env.HOTCLIP_LLM_API_KEY ?? "ollama", model };
}
