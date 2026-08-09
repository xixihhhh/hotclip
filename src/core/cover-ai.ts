/**
 * AI 封面双档(v0.14):抓帧封面之外,按切片标题生成一张竖版大字封面。
 * 走量档 Seedream(字节,海报排版/中文字强,便宜)、精品档 Nano Banana
 * Pro(谷歌,细节与中文大字渲染最稳,贵一档)——正是调研里「封面双档」
 * 的两个点名模型。生成的封面落成片旁的 <名>.封面AI.jpg,与抓帧封面并存
 * 由用户挑;fail-open,封面生成失败绝不拖垮导出。
 */
import { atlasMediaBase, generateMedia, downloadMedia } from "./atlas-media";

export type CoverTier = "volume" | "premium";

/** 双档模型 id(Atlas Cloud,2026-08 核对)。 */
export const COVER_MODELS: Record<CoverTier, string> = {
  volume: "bytedance/seedream-v4.5",
  premium: "google/nano-banana-pro/text-to-image",
};

/** 单张原价(美元;Atlas 常年促销价更低,预估按原价留余量)。 */
export const COVER_COST_USD: Record<CoverTier, number> = {
  volume: 0.036,
  premium: 0.14,
};

/** 单张生成预算(提交+轮询+下载)。 */
export const COVER_TIMEOUT_MS = 90_000;

/** 标题截断:按视觉宽度(汉字=2、拉丁=1)截到 32 单位——中文 16 字、英文 32 字符。 */
function clipHeadline(text: string, maxUnits = 32): string {
  let units = 0;
  let out = "";
  for (const ch of text) {
    units += /[⺀-鿿豈-﫿]/.test(ch) ? 2 : 1;
    if (units > maxUnits) break;
    out += ch;
  }
  return out;
}

/**
 * 封面提示词:2026 直播切片封面的工艺共识——竖版 3:4、超大加粗中文标题
 * (原样渲染,放引号里防改写)、高对比撞色、真实直播感画面而非 AI 塑料感。
 * 标题超长时截断进画面(封面大字要少而大,长句是设计事故)。
 */
export function coverPrompt(title: string, hook: string | undefined, zh: boolean): string {
  const headline = clipHeadline(title.trim());
  const scene = hook?.trim() ? hook.trim().slice(0, 60) : title.trim().slice(0, 40);
  if (zh) {
    return [
      `竖版 3:4 直播切片封面海报。画面主体:${scene}的真实直播场景感,真人质感、抓拍感、高清。`,
      `超大加粗中文标题文字:「${headline}」,原样渲染这几个字,不要改写、不要错别字;`,
      "标题占画面上三分之一,粗黑体白字加高对比描边或色块底,手机小屏可读。",
      "整体高对比、饱和撞色、有冲击力;避免 AI 塑料感、避免多余英文、避免水印。",
    ].join("\n");
  }
  return [
    `Vertical 3:4 livestream-clip cover poster. Subject: authentic live-stream candid feel of ${scene}, photoreal, sharp.`,
    `Huge bold headline text: "${headline}" — render these exact words, no rewording, no typos;`,
    "headline fills the top third, heavy sans-serif with high-contrast outline or color block, readable on a phone screen.",
    "High contrast, punchy saturated colors; avoid plastic AI look, avoid watermarks.",
  ].join("\n");
}

/** 按档位组装 Atlas 请求体(两家模型的画幅参数不同名)。 */
export function coverRequestBody(tier: CoverTier, prompt: string): Record<string, unknown> {
  if (tier === "premium") {
    return {
      model: COVER_MODELS.premium,
      prompt,
      aspect_ratio: "3:4",
      resolution: "1k",
      output_format: "jpeg",
    };
  }
  return { model: COVER_MODELS.volume, prompt, size: "1728*2304" };
}

/**
 * 生成一张 AI 封面到 outPath。LLM baseUrl 非 Atlas(或没 Key)返回 false
 * (调用方据此静默跳过);其余失败抛错由调用方 fail-open。
 */
export async function generateAiCover(opts: {
  tier: CoverTier;
  title: string;
  hook?: string;
  zh: boolean;
  baseUrl: string;
  apiKey: string;
  outPath: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  const mediaBase = atlasMediaBase(opts.baseUrl);
  if (!mediaBase || !opts.apiKey) return false;
  const url = await generateMedia("generateImage", coverRequestBody(opts.tier, coverPrompt(opts.title, opts.hook, opts.zh)), {
    mediaBase,
    apiKey: opts.apiKey,
    timeoutMs: COVER_TIMEOUT_MS,
    signal: opts.signal,
  });
  await downloadMedia(url, opts.outPath, opts.signal);
  return true;
}
