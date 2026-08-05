/**
 * 出片偏好记忆:工具条的开关组合(竖屏/字幕样式/跳剪/双语/发布文案/时长档…)
 * 持久化到本机——用户每换一个视频不用再把十来个开关重新点一遍,上次怎么出
 * 这次还怎么出。多人对谈(diarize)故意不记:它对单视频生效,换素材要重判。
 */
import { create } from "zustand";
import type { CaptionStyleChoice, ClipLength, ExportQuality } from "../../../shared/api-types";
import { validPlatformIds } from "../../../shared/platform-specs";

const STORAGE_KEY = "hotclip-render-prefs";

export interface RenderPrefs {
  vertical: boolean;
  captionStyle: CaptionStyleChoice;
  jumpCut: boolean;
  cleanFillers: boolean;
  cutRetakes: boolean;
  autoZoom: boolean;
  /** 音效打点:whoosh 卡拼接缝/ding 卡情绪峰/pop 卡开场钩子。 */
  sfx: boolean;
  /** BGM 文件路径;空串 = 不加 BGM。 */
  bgmPath: string;
  trimUi: boolean;
  titleCard: boolean;
  openingHook: boolean;
  normalizeLoudness: boolean;
  denoise: boolean;
  compilation: boolean;
  coldOpen: boolean;
  /** 爆点闪现:峰值画面 0.3-1s 前置(视觉钩子)。 */
  flashForward: boolean;
  /** 精准切点:Paraformer 二遍对齐修正词级时间戳。 */
  preciseAlign: boolean;
  alsoLandscape: boolean;
  translate: boolean;
  publishCopy: boolean;
  subtitleFile: boolean;
  timeline: boolean;
  aigcLabel: boolean;
  /** 平台发布包:每平台一个「拿起来就能发」的齐套文件夹。 */
  publishPack: boolean;
  /** 发布包选中的平台 id(platform-specs.ts)。 */
  packPlatforms: string[];
  /** 一片多版:总版本数(1=关,2/3=同一切片出几版差异化包装)。 */
  variants: number;
  clipLength: ClipLength;
  /** 直播品类判据(见 core/genre.ts);custom 时用 genreCustom 的文本。 */
  genreId: string;
  /** 用户改写的判据文本;非空时一律盖过内置预设。 */
  genreCustom: string;
  /** 成片导出根目录;空串 = 跟随系统默认(~/影片/HotClip)。 */
  outDir: string;
  /** 导出画质档(CRF 18/23/28);出厂 high = 历史默认画质。 */
  quality: ExportQuality;
}

/** 与出厂默认一致:开箱即出竖屏卡拉OK跳剪片;花钱/额外文件的默认关。 */
export const RENDER_PREF_DEFAULTS: RenderPrefs = {
  vertical: true,
  captionStyle: "keyword",
  jumpCut: true,
  cleanFillers: true,
  cutRetakes: false, // 剪掉的是完整一句话,误伤代价高——默认关,由用户按素材开
  autoZoom: false, // 运镜是风格化选择(素材本身有运动时会打架),默认关
  sfx: false, // 音效改变成片听感,默认关由用户选择(打点规则见 sound-design.ts)
  bgmPath: "", // BGM 是强风格选择且涉及用户自备素材,默认不加
  trimUi: true,
  titleCard: true,
  openingHook: true,
  normalizeLoudness: true,
  denoise: false, // 素材千差万别,降噪宁保守默认关
  compilation: false, // 合集是额外产物,默认关
  coldOpen: false, // 高潮前置改变成片结构,默认关由用户选择
  flashForward: false, // 爆点闪现同理:强风格开场,默认关
  preciseAlign: false, // 首次要下载 ~240MB 模型且每条多几秒解码,默认关
  alsoLandscape: false, // 多画幅导出时间翻倍,默认关
  translate: false,
  publishCopy: false,
  subtitleFile: false,
  timeline: false,
  aigcLabel: false,
  publishPack: false, // 发布包产生一堆文件夹,默认关由用户按需开
  packPlatforms: ["douyin", "xiaohongshu", "channels"], // 中文矩阵最常见的三件套
  variants: 1, // 多版=多倍导出时间+一次 LLM 调用,默认关
  clipLength: "standard",
  genreId: "auto", // 出厂不指定品类:通用提示词里已让模型先自判内容类型
  genreCustom: "",
  outDir: "", // 出厂跟随系统默认目录,用户选过才存绝对路径
  quality: "high", // 与升级前的成片一致,换档是用户的主动选择
};

function load(): RenderPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<RenderPrefs>;
      // 逐字段校验:坏值回落默认,新增字段自动补齐
      const out = { ...RENDER_PREF_DEFAULTS };
      for (const key of Object.keys(RENDER_PREF_DEFAULTS) as Array<keyof RenderPrefs>) {
        const v = p[key];
        if (typeof v === typeof RENDER_PREF_DEFAULTS[key]) {
          (out as Record<string, unknown>)[key] = v;
        }
      }
      // 数组/枚举字段 typeof 校验不够严,逐个补严校验
      out.packPlatforms = Array.isArray(out.packPlatforms)
        ? validPlatformIds(out.packPlatforms.filter((x): x is string => typeof x === "string"))
        : [...RENDER_PREF_DEFAULTS.packPlatforms];
      if (![1, 2, 3].includes(out.variants)) out.variants = 1;
      if (!["short", "standard", "long"].includes(out.clipLength)) out.clipLength = "standard";
      if (!["high", "standard", "compact"].includes(out.quality)) out.quality = "high";
      if (!["keyword", "pop", "minimal", "hormozi", "bubble", "karaoke", "none"].includes(out.captionStyle)) out.captionStyle = "keyword";
      return out;
    }
  } catch {
    /* 回落默认 */
  }
  return { ...RENDER_PREF_DEFAULTS };
}

interface RenderPrefsState {
  prefs: RenderPrefs;
  setPref: (partial: Partial<RenderPrefs>) => void;
}

export const useRenderPrefs = create<RenderPrefsState>((set, get) => ({
  prefs: load(),
  setPref: (partial) => {
    const prefs = { ...get().prefs, ...partial };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      /* persistence is best-effort */
    }
    set({ prefs });
  },
}));
