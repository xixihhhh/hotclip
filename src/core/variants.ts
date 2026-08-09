/**
 * 一片多版:同一条切片生成 N 套差异化包装——不同钩子角度的贴片标题、
 * 开场悬念句、发布文案,封面另抓不同的响度峰帧。多账号分发同一内容时,
 * 靠「真差异」(角度/标题/封面/文案都不同)而不是像素级去重(抽帧/镜像
 * 已被平台明确判搬运)。
 *
 * 一次 LLM 调用为整批切片出全部变体计划;fail-open——生成失败只是没有
 * 变体,绝不拖垮导出。展开逻辑(计划 → 追加的导出 spec)是纯函数可单测。
 */
import type { LlmConfig } from "../shared/api-types";
import { stripThinkBlocks } from "./highlight/prefilter";
import { hookAngleMenu, ctaMenu } from "./copy-templates";
import { parsePostFields, publishUserPrompt, type PublishCopy, type PublishSource, type PublishChatFn } from "./publish";
import type { ExportClipSpec } from "./export";

/** 总版本数上限(含原版):3 版已覆盖「三个账号错峰发」的主流玩法。 */
export const VARIANT_TOTAL_MAX = 3;
/** 单次生成超时(整批一次调用)。 */
export const VARIANTS_TIMEOUT_MS = 120_000;
/** 解析失败重发次数(与 detect 的 JSON_ATTEMPTS 同口径:偶发杂质 token)。 */
const ATTEMPTS = 2;

/** 一套变体包装。 */
export interface VariantPackaging {
  /** 贴片标题(烧进画面,兼作文件名)。 */
  title: string;
  /** 开场悬念句(黄金3秒大字);模型想不出贴切的会省略。 */
  teaser?: string;
  /** 该版的发布文案(标题/话题/简介/CTA)。 */
  post?: PublishCopy;
}

export function variantSystemPrompt(zh: boolean, extraCount: number): string {
  if (zh) {
    return [
      "你是短视频运营。同一条切片要发多个账号,每个账号要一版差异化包装——不是同义改写,是换一个钩子角度重新包装同一段内容。",
      `为每条切片在原版之外再给 ${extraCount} 套包装,每套输出:`,
      "title=烧进画面的贴片标题(≤20字,必须换角度,不能只是原标题换词);",
      "teaser=开场悬念句(≤18字,大字压在开头;想不出贴切的就省略这个字段);",
      "post=发布文案对象:{title:发布标题≤30字, hashtags:3-6个带#话题, description:≤60字简介, cta:≤20字行动号召, angle/ctaType:从菜单选}。",
      "钩子角度菜单:",
      hookAngleMenu(true),
      "CTA 菜单:",
      ctaMenu(true),
      "同一条切片的各版必须用不同 angle,与原版标题的角度也要错开。",
      '严格只输出 JSON:{"clips":[{"id":1,"variants":[{"title":"…","teaser":"…","post":{"title":"…","hashtags":["#…"],"description":"…","angle":"question","cta":"…","ctaType":"comment"}}]}]}',
    ].join("\n");
  }
  return [
    "You are a short-video social manager. The same clip goes out on multiple accounts, each needing a genuinely different packaging — a different hook angle, not a paraphrase.",
    `For each clip give ${extraCount} extra packaging(s) besides the original. Each one outputs:`,
    "title = on-screen title card (≤ 40 chars, must take a different angle);",
    "teaser = opening hook line (≤ 36 chars; omit the field if nothing fits);",
    "post = post copy object: {title ≤ 60 chars, hashtags: 3-6 with #, description ≤ 120 chars, cta ≤ 40 chars, angle/ctaType from the menus}.",
    "Hook angle menu:",
    hookAngleMenu(false),
    "CTA menu:",
    ctaMenu(false),
    "Variants of one clip must use different angles from each other and from the original title.",
    'Output STRICT JSON only: {"clips":[{"id":1,"variants":[{"title":"…","teaser":"…","post":{…}}]}]}',
  ].join("\n");
}

/**
 * 解析变体计划。整体不是 JSON 时抛错(上层借此重发一次);单条垃圾行
 * 静默丢弃。每条切片的变体数截到 perClipMax。
 */
export function parseVariantPlans(
  content: string,
  validIds: Set<number>,
  perClipMax: number
): Map<number, VariantPackaging[]> {
  const cleaned = stripThinkBlocks(content);
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("variants: no JSON in response");
  const obj = JSON.parse(match[0]) as { clips?: unknown };
  const out = new Map<number, VariantPackaging[]>();
  if (!Array.isArray(obj.clips)) return out;
  for (const c of obj.clips) {
    const rec = c as { id?: unknown; variants?: unknown };
    const id = Number(rec.id);
    if (!Number.isInteger(id) || !validIds.has(id) || !Array.isArray(rec.variants)) continue;
    const list: VariantPackaging[] = [];
    for (const v of rec.variants) {
      const vr = v as { title?: unknown; teaser?: unknown; post?: unknown };
      if (typeof vr.title !== "string" || !vr.title.trim()) continue;
      const teaser = typeof vr.teaser === "string" && vr.teaser.trim() ? vr.teaser.trim() : undefined;
      const post = parsePostFields(vr.post) ?? undefined;
      list.push({ title: vr.title.trim(), ...(teaser ? { teaser } : {}), ...(post ? { post } : {}) });
      if (list.length >= perClipMax) break;
    }
    if (list.length > 0) out.set(id, list);
  }
  return out;
}

/**
 * 生成变体计划(整批一次调用)。fail-open:失败/垃圾输出返回 null;
 * 上游取消原样上抛。totalCount 是含原版的总版本数(2 或 3)。
 */
export async function generateVariantPlans(
  sources: PublishSource[],
  totalCount: number,
  zh: boolean,
  llm: LlmConfig,
  chat: PublishChatFn,
  signal?: AbortSignal
): Promise<Map<number, VariantPackaging[]> | null> {
  const extra = Math.min(totalCount, VARIANT_TOTAL_MAX) - 1;
  if (sources.length === 0 || extra < 1) return null;
  const validIds = new Set(sources.map((s) => s.id));
  const system = variantSystemPrompt(zh, extra);
  const user = publishUserPrompt(sources);
  try {
    const timeout = AbortSignal.timeout(VARIANTS_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let lastErr: unknown;
    for (let i = 0; i < ATTEMPTS; i++) {
      const content = await chat(llm, system, user, combined);
      try {
        const parsed = parseVariantPlans(content, validIds, extra);
        return parsed.size > 0 ? parsed : null;
      } catch (e) {
        if (combined.aborted) throw e;
        lastErr = e; // 偶发杂质 token 让整份 JSON 非法——重发一次
      }
    }
    throw lastErr;
  } catch (e) {
    if (signal?.aborted) throw e;
    return null;
  }
}

/**
 * 把变体计划展开成追加的导出 spec:每个变体克隆原 spec,换标题/悬念句/
 * 文案,封面改抓下一个响度峰(coverRank),id 从现有最大值续编保证唯一。
 * 与原标题一字不差的变体丢弃(没有差异化价值)。attachPost=false 时
 * (用户没开发布文案)变体也不带文案,与原版行为一致。
 * flashDim=true(全局爆点闪现没开)时,每条切片的最后一个变体再叠一层
 * 结构差异:强制开 flash-forward 开场——变体不只换包装,连开场结构都
 * 不同(v0.14 反量产指纹的「真差异」维度;闪不出来自动回退,fail-open)。
 */
export function expandClipSpecs(
  specs: ExportClipSpec[],
  plans: Map<number, VariantPackaging[]>,
  attachPost: boolean,
  flashDim = false
): ExportClipSpec[] {
  let nextId = specs.reduce((m, s) => Math.max(m, s.id), 0) + 1;
  const out: ExportClipSpec[] = [];
  for (const spec of specs) {
    out.push(spec);
    let seq = 1; // 原版是第 1 版
    const usable = (plans.get(spec.id) ?? []).filter((v) => v.title !== spec.title.trim());
    for (const v of usable) {
      seq++;
      out.push({
        ...spec,
        id: nextId++,
        title: v.title,
        variantOf: spec.id,
        variant: seq,
        coverRank: seq - 1, // 第 2 版抓第 2 峰,以此类推
        // 最后一版换开场结构(爆点闪现),前面的版只换包装
        flashForward: flashDim && seq === usable.length + 1 ? true : spec.flashForward,
        publish: attachPost ? (v.post ?? spec.publish) : undefined,
        meta: spec.meta ? { ...spec.meta, teaser: v.teaser ?? spec.meta.teaser } : undefined,
      });
    }
  }
  return out;
}
