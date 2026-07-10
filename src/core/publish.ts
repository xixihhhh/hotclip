/**
 * 发布文案生成:为每条切片批量生成「发布标题 + 话题标签 + 两句简介」,
 * 落成 mp4 旁的 .post.txt(创作者直接复制粘贴)并写进 clips.json——
 * 补上「切完直接发」的最后一公里:片子有了,发布框里写什么。
 *
 * 素材全部来自检测阶段的证据链(title/hook/正文/keywords),一次 LLM 调用
 * 批量生成所有选中切片。fail-open:生成失败/缺条都只是没有文案,绝不拖垮
 * 导出。纯函数(prompt/解析/成文)可单测;LLM 调用注入。
 */
import type { LlmConfig } from "../shared/api-types";
import { stripThinkBlocks } from "./highlight/prefilter";

/** 单条切片的发布文案。 */
export interface PublishCopy {
  /** 发布标题(平台风格,带钩子,≤30字)。 */
  title: string;
  /** 话题标签(含 # 前缀,3-6 个)。 */
  hashtags: string[];
  /** 一两句简介(补充钩子、引导互动)。 */
  description: string;
}

/** 生成输入:每条切片的证据链素材。 */
export interface PublishSource {
  id: number;
  title: string;
  hook: string;
  /** 片内正文(超长会被截断)。 */
  text: string;
  keywords: string[];
}

/** 与 detect.ts 的 chatComplete 同形的注入点。 */
export type PublishChatFn = (llm: LlmConfig, system: string, user: string, signal?: AbortSignal) => Promise<string>;

/** 单次生成超时。 */
export const PUBLISH_TIMEOUT_MS = 90_000;
/** 正文素材截断长度(标题/钩子/关键词才是主料,正文只是补语境)。 */
const TEXT_EXCERPT_CHARS = 300;
const MAX_HASHTAGS = 6;

export function publishSystemPrompt(zh: boolean): string {
  if (zh) {
    return [
      "你是短视频运营,为每条切片写发布文案(抖音/小红书/视频号通用)。",
      "每条输出:title=发布标题(≤30字,有钩子:提问/悬念/反差,别用片名原文照抄);",
      "hashtags=3-6 个话题标签(带#,垂类词优先,泛词最多1个);",
      "description=一两句简介(补充钩子或引导互动,≤60字,不要堆表情)。",
      '严格只输出 JSON:{"posts":[{"id":1,"title":"…","hashtags":["#…"],"description":"…"}]},id 与输入一一对应。',
    ].join("\n");
  }
  return [
    "You are a short-video social manager writing post copy for each clip (TikTok/Shorts/Reels).",
    "For each clip output: title = a post title (≤ 60 chars, hooky: question/suspense/contrast, don't copy the clip name verbatim);",
    "hashtags = 3-6 tags (with #, niche terms first, at most one generic tag);",
    "description = one or two sentences (≤ 120 chars, extend the hook or invite interaction, no emoji spam).",
    'Output STRICT JSON only: {"posts":[{"id":1,"title":"…","hashtags":["#…"],"description":"…"}]}, ids matching the input.',
  ].join("\n");
}

export function publishUserPrompt(sources: PublishSource[]): string {
  return sources
    .map((s) => {
      const kw = s.keywords.length > 0 ? ` 关键词:${s.keywords.join("/")}` : "";
      return `[${s.id}] 片名:${s.title} 钩子:${s.hook}${kw}\n正文节选:${s.text.slice(0, TEXT_EXCERPT_CHARS)}`;
    })
    .join("\n\n");
}

/** 解析生成输出 → id→文案;垃圾输出返回空 Map(fail-open 到"没有文案")。 */
export function parsePublishCopies(content: string, validIds: Set<number>): Map<number, PublishCopy> {
  const out = new Map<number, PublishCopy>();
  const cleaned = stripThinkBlocks(content);
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return out;
  let obj: unknown;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return out;
  }
  const posts = (obj as { posts?: unknown }).posts;
  if (!Array.isArray(posts)) return out;
  for (const p of posts) {
    const rec = p as { id?: unknown; title?: unknown; hashtags?: unknown; description?: unknown };
    const id = Number(rec.id);
    if (!Number.isInteger(id) || !validIds.has(id)) continue;
    if (typeof rec.title !== "string" || !rec.title.trim()) continue;
    const hashtags = Array.isArray(rec.hashtags)
      ? rec.hashtags
          .filter((h): h is string => typeof h === "string" && h.trim().length > 1)
          .map((h) => (h.trim().startsWith("#") ? h.trim() : `#${h.trim()}`))
          .slice(0, MAX_HASHTAGS)
      : [];
    out.set(id, {
      title: rec.title.trim(),
      hashtags,
      description: typeof rec.description === "string" ? rec.description.trim() : "",
    });
  }
  return out;
}

/**
 * 批量生成发布文案。fail-open:失败返回 null(调用方据此不写文案文件);
 * 上游取消原样上抛。
 */
export async function generatePublishCopies(
  sources: PublishSource[],
  zh: boolean,
  llm: LlmConfig,
  chat: PublishChatFn,
  signal?: AbortSignal
): Promise<Map<number, PublishCopy> | null> {
  if (sources.length === 0) return null;
  try {
    const timeout = AbortSignal.timeout(PUBLISH_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const content = await chat(llm, publishSystemPrompt(zh), publishUserPrompt(sources), combined);
    const parsed = parsePublishCopies(content, new Set(sources.map((s) => s.id)));
    return parsed.size > 0 ? parsed : null;
  } catch (e) {
    if (signal?.aborted) throw e;
    return null;
  }
}

/** .post.txt 内容:标题 + 空行 + 话题 + 空行 + 简介,直接全选复制。 */
export function postTextFile(copy: PublishCopy): string {
  const parts = [copy.title];
  if (copy.hashtags.length > 0) parts.push(copy.hashtags.join(" "));
  if (copy.description) parts.push(copy.description);
  return parts.join("\n\n") + "\n";
}
