/**
 * 出片偏好记忆:工具条的开关组合(竖屏/字幕样式/跳剪/双语/发布文案/时长档…)
 * 持久化到本机——用户每换一个视频不用再把十来个开关重新点一遍,上次怎么出
 * 这次还怎么出。多人对谈(diarize)故意不记:它对单视频生效,换素材要重判。
 */
import { create } from "zustand";
import type { CaptionStyleChoice, ClipLength, ExportQuality } from "../../../shared/api-types";

const STORAGE_KEY = "hotclip-render-prefs";

export interface RenderPrefs {
  vertical: boolean;
  captionStyle: CaptionStyleChoice;
  jumpCut: boolean;
  cleanFillers: boolean;
  cutRetakes: boolean;
  autoZoom: boolean;
  trimUi: boolean;
  titleCard: boolean;
  openingHook: boolean;
  normalizeLoudness: boolean;
  denoise: boolean;
  compilation: boolean;
  coldOpen: boolean;
  alsoLandscape: boolean;
  translate: boolean;
  publishCopy: boolean;
  subtitleFile: boolean;
  timeline: boolean;
  aigcLabel: boolean;
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
  captionStyle: "karaoke",
  jumpCut: true,
  cleanFillers: true,
  cutRetakes: false, // 剪掉的是完整一句话,误伤代价高——默认关,由用户按素材开
  autoZoom: false, // 运镜是风格化选择(素材本身有运动时会打架),默认关
  trimUi: true,
  titleCard: true,
  openingHook: true,
  normalizeLoudness: true,
  denoise: false, // 素材千差万别,降噪宁保守默认关
  compilation: false, // 合集是额外产物,默认关
  coldOpen: false, // 高潮前置改变成片结构,默认关由用户选择
  alsoLandscape: false, // 多画幅导出时间翻倍,默认关
  translate: false,
  publishCopy: false,
  subtitleFile: false,
  timeline: false,
  aigcLabel: false,
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
      if (!["short", "standard", "long"].includes(out.clipLength)) out.clipLength = "standard";
      if (!["high", "standard", "compact"].includes(out.quality)) out.quality = "high";
      if (!["karaoke", "keyword", "pop", "hormozi", "bubble", "none"].includes(out.captionStyle)) out.captionStyle = "karaoke";
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
