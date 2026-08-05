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
import { ctaMenu, hookAngleMenu, isCtaType, isHookAngle, type CtaTypeId, type HookAngleId } from "./copy-templates";

/** 单条切片的发布文案。 */
export interface PublishCopy {
  /** 发布标题(平台风格,带钩子,≤30字)。 */
  title: string;
  /** 话题标签(含 # 前缀,3-6 个)。 */
  hashtags: string[];
  /** 一两句简介(补充钩子、引导互动)。 */
  description: string;
  /** 标题采用的钩子角度(copy-templates 菜单;缺省=旧数据或模型没标)。 */
  angle?: HookAngleId;
  /** 收尾行动号召一句(复制时缀在简介后)。 */
  cta?: string;
  /** CTA 类型(copy-templates 菜单)。 */
  ctaType?: CtaTypeId;
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
      "每条输出:title=发布标题(≤30字,别用片名原文照抄)。下笔前先从钩子角度菜单里挑最贴合内容的一个,整批切片换着用,别全走同一个套路:",
      hookAngleMenu(true),
      "hashtags=3-6 个话题标签(带#,垂类词优先,泛词最多1个);",
      "description=一两句简介(补充钩子或语境,≤60字,不要堆表情);",
      "cta=一句收尾行动号召(≤20字),类型从菜单里挑与内容匹配的:",
      ctaMenu(true),
      '严格只输出 JSON:{"posts":[{"id":1,"angle":"question","title":"…","hashtags":["#…"],"description":"…","ctaType":"comment","cta":"…"}]},id 与输入一一对应,angle/ctaType 必须用菜单里的 id。',
    ].join("\n");
  }
  return [
    "You are a short-video social manager writing post copy for each clip (TikTok/Shorts/Reels).",
    "For each clip output: title = a post title (≤ 60 chars, don't copy the clip name verbatim). Pick the best-fitting hook angle from this menu first, and vary angles across the batch:",
    hookAngleMenu(false),
    "hashtags = 3-6 tags (with #, niche terms first, at most one generic tag);",
    "description = one or two sentences (≤ 120 chars, extend the hook, no emoji spam);",
    "cta = one closing call-to-action line (≤ 40 chars), typed from this menu to match the content:",
    ctaMenu(false),
    'Output STRICT JSON only: {"posts":[{"id":1,"angle":"question","title":"…","hashtags":["#…"],"description":"…","ctaType":"comment","cta":"…"}]}, ids matching the input, angle/ctaType from the menus.',
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

/**
 * 从一个 LLM 输出对象里解析文案字段(title 必填,其余按约定校验)。
 * 发布文案与一片多版(variants.ts)共用同一套字段口径。
 */
export function parsePostFields(p: unknown): PublishCopy | null {
  const rec = p as {
    title?: unknown; hashtags?: unknown; description?: unknown;
    angle?: unknown; cta?: unknown; ctaType?: unknown;
  } | null;
  if (!rec || typeof rec.title !== "string" || !rec.title.trim()) return null;
  const hashtags = Array.isArray(rec.hashtags)
    ? rec.hashtags
        .filter((h): h is string => typeof h === "string" && h.trim().length > 1)
        .map((h) => (h.trim().startsWith("#") ? h.trim() : `#${h.trim()}`))
        .slice(0, MAX_HASHTAGS)
    : [];
  // 角度/CTA 类型:菜单外的值直接丢弃(fail-open 成"没标"),不猜不改写
  const cta = typeof rec.cta === "string" && rec.cta.trim() ? rec.cta.trim() : undefined;
  return {
    title: rec.title.trim(),
    hashtags,
    description: typeof rec.description === "string" ? rec.description.trim() : "",
    ...(isHookAngle(rec.angle) ? { angle: rec.angle } : {}),
    ...(cta ? { cta } : {}),
    ...(cta && isCtaType(rec.ctaType) ? { ctaType: rec.ctaType } : {}),
  };
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
    const rec = p as { id?: unknown };
    const id = Number(rec.id);
    if (!Number.isInteger(id) || !validIds.has(id)) continue;
    const copy = parsePostFields(p);
    if (copy) out.set(id, copy);
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

/** .post.txt 内容:标题 + 空行 + 话题 + 空行 + 简介(CTA 缀在简介后一行),直接全选复制。 */
export function postTextFile(copy: PublishCopy): string {
  const parts = [copy.title];
  if (copy.hashtags.length > 0) parts.push(copy.hashtags.join(" "));
  const body = [copy.description, copy.cta ?? ""].filter(Boolean).join("\n");
  if (body) parts.push(body);
  return parts.join("\n\n") + "\n";
}
