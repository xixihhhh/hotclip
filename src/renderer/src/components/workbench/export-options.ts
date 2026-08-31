/**
 * 出片选项组装:偏好 + 会话态 → RenderToggles。
 * 手动出片与一键托管共用这一份——原先托管路径写死一套默认开关,
 * 与手动出片各长各的,改一处漏一处。
 */
import type { RenderToggles, LlmConfig, Transcript } from "../../../../shared/api-types";
import type { RenderPrefs } from "../../stores/render-prefs-store";
import { activeBrandStyle } from "../../stores/brand-store";

export function buildRenderToggles(opts: {
  prefs: RenderPrefs;
  config: LlmConfig;
  brandState: Parameters<typeof activeBrandStyle>[0];
  diarize: boolean;
  transcript: Transcript | null;
  /** AI 生成媒体档可用(LLM 指向 Atlas 且带 Key)。 */
  atlasReady: boolean;
}): RenderToggles {
  const { prefs, config, brandState, diarize, transcript, atlasReady } = opts;
  // 中文源译英,其余译中——短视频出海/引进的两个主方向
  const targetLang = (transcript?.language || "").startsWith("zh") ? "en" : "zh";
  return {
    vertical: prefs.vertical,
    captionStyle: prefs.captionStyle,
    jumpCut: prefs.jumpCut,
    keepBreath: prefs.keepBreath,
    speakerLabels: prefs.speakerLabels && diarize,
    templateJitter: prefs.templateJitter,
    cleanFillers: prefs.cleanFillers,
    cutRetakes: prefs.cutRetakes,
    autoZoom: prefs.autoZoom,
    autoEnhance: prefs.autoEnhance,
    sfx: prefs.sfx,
    bgmPath: prefs.bgmPath || undefined,
    genreId: prefs.genreId,
    preciseAlign: prefs.preciseAlign,
    trimUi: prefs.trimUi,
    titleCard: prefs.titleCard,
    openingHook: prefs.openingHook,
    coldOpen: prefs.coldOpen,
    flashForward: prefs.flashForward,
    alsoLandscape: prefs.alsoLandscape,
    normalizeLoudness: prefs.normalizeLoudness,
    denoise: prefs.denoise,
    denoiseMode: prefs.denoiseMode,
    muteTerms: prefs.muteSensitive && prefs.sensitiveWords.length > 0 ? prefs.sensitiveWords : undefined,
    compilation: prefs.compilation,
    brand: activeBrandStyle(brandState),
    translate: prefs.translate ? { targetLang, llm: config } : undefined,
    publishCopy: prefs.publishCopy ? { llm: config } : undefined,
    subtitleFile: prefs.subtitleFile,
    timeline: prefs.timeline,
    jianyingDraft: prefs.jianyingDraft,
    aigcLabel: prefs.aigcLabel,
    evidencePack: prefs.evidencePack,
    publishPack: prefs.publishPack && prefs.packPlatforms.length > 0 ? prefs.packPlatforms : undefined,
    seriesPack: prefs.seriesPack,
    variants: prefs.variants > 1 ? { count: prefs.variants, llm: config } : undefined,
    aiCover: prefs.aiCover !== "off" && atlasReady ? { tier: prefs.aiCover, llm: config } : undefined,
    outDir: prefs.outDir,
    quality: prefs.quality,
  };
}
