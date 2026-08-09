/**
 * AI BGM 云端档(v0.14):按直播品类生成一段版权安全的纯音乐,存本地后
 * 走既有 bgmPath 混音链(循环铺满/人声闪避/结尾淡出全部复用)。平台对
 * BGM 版权查得严,商用曲库贵——生成音乐没有第三方版权主张,是切片党
 * 的「版权安全」解法。MiniMax Music(Atlas 档)一次一整首,$0.15/首。
 */
import { join } from "path";
import { mkdir } from "fs/promises";
import { atlasMediaBase, generateMedia, downloadMedia } from "./atlas-media";

/** 模型与单价(原价口径;Atlas 促销价更低)。 */
export const BGM_MODEL = "minimax/music-2.6";
export const BGM_COST_USD = 0.15;

/** 一首歌生成较慢(真机实测 150-180s+),预算给到 2 倍余量。 */
export const BGM_TIMEOUT_MS = 360_000;

/**
 * 品类 → BGM 风格提示词(英文——音乐模型的风格词汇以英文语料为主)。
 * 统一约束:纯音乐、循环友好(BGM 要 loop)、不喧宾夺主(要压在人声下)。
 */
const STYLE_BY_GENRE: Record<string, string> = {
  shopping: "upbeat bright pop funk instrumental, playful shopping vibe, steady groove, 118bpm",
  game: "energetic electronic synthwave instrumental, driving beat, gaming energy, 128bpm",
  esports: "epic hybrid electronic orchestral instrumental, tension and release, stadium energy",
  knowledge: "warm lofi chillhop instrumental, soft keys, focused calm study mood, 85bpm",
  talk: "light jazzy lounge instrumental, brushed drums, relaxed conversational mood",
  food: "cozy acoustic bossa nova instrumental, warm guitar, appetizing cafe mood",
  outdoor: "fresh acoustic folk instrumental, bright strums, sunny travel mood",
  show: "catchy dance pop instrumental, four-on-the-floor, stage performance energy, 124bpm",
  radio: "ambient late-night lofi instrumental, mellow pads, intimate radio mood",
  interview: "minimal warm ambient instrumental, soft piano, thoughtful podcast mood",
};

const STYLE_DEFAULT = "modern upbeat pop instrumental, clean mix, positive energy, 115bpm";

/** BGM 风格提示词:品类未知/未收录走通用欢快档。 */
export function bgmPrompt(genreId: string | undefined): string {
  const style = (genreId && STYLE_BY_GENRE[genreId]) || STYLE_DEFAULT;
  // 循环友好 + 无人声 + 留出人声空间——BGM 的三条硬要求
  return `${style}, instrumental only, no vocals, loop-friendly structure, consistent energy, background music that leaves space for speech`;
}

/**
 * 生成一首 AI BGM 到 destDir(文件名带品类与时间戳,重复生成不覆盖),
 * 返回保存路径。baseUrl 非 Atlas 或缺 Key 抛错(入口在 UI 已按配置禁用,
 * 走到这里还不可用属于异常,要让用户看到原因而不是静默没反应)。
 */
export async function generateAiBgm(opts: {
  genreId?: string;
  baseUrl: string;
  apiKey: string;
  destDir: string;
  signal?: AbortSignal;
  /** 时间戳注入(默认 Date.now;测试可传定值)。 */
  now?: () => number;
}): Promise<string> {
  const mediaBase = atlasMediaBase(opts.baseUrl);
  if (!mediaBase) throw new Error("AI BGM 需要 Atlas Cloud 端点(设置里把 AI 服务切到 Atlas 档)");
  if (!opts.apiKey) throw new Error("AI BGM 需要 API Key");
  const url = await generateMedia(
    "generateAudio",
    { model: BGM_MODEL, prompt: bgmPrompt(opts.genreId), is_instrumental: true, format: "mp3", sample_rate: 44100, bitrate: 256000 },
    { mediaBase, apiKey: opts.apiKey, timeoutMs: BGM_TIMEOUT_MS, signal: opts.signal }
  );
  await mkdir(opts.destDir, { recursive: true });
  const stamp = new Date((opts.now ?? Date.now)()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dest = join(opts.destDir, `ai-bgm-${opts.genreId ?? "auto"}-${stamp}.mp3`);
  await downloadMedia(url, dest, opts.signal);
  return dest;
}
