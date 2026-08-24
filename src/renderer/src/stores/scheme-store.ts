/**
 * 出片方案:一组出片开关的命名快照。原先 33 个开关每换一类素材都要
 * 逐个点一遍——方案让「带货全家桶」「极简省时」这类组合一键切换;
 * 用户当前组合也能存成自己的方案。应用方案 = 批量写入 render-prefs。
 *
 * 快照只覆盖「怎么出片」的开关,不动检测参数(品类/点题在会话侧)与
 * 路径类偏好(outDir/bgmPath 跟素材与机器走,不该被方案覆盖)。
 */
import { create } from "zustand";
import { RENDER_PREF_DEFAULTS, type RenderPrefs } from "./render-prefs-store";

const STORAGE_KEY = "hotclip-schemes";

/** 进方案快照的字段(白名单;新增开关默认不进,想进来显式加)。 */
export const SCHEME_KEYS = [
  "vertical", "alsoLandscape", "trimUi", "titleCard", "autoZoom",
  "jumpCut", "keepBreath", "cleanFillers", "cutRetakes", "preciseAlign",
  "openingHook", "coldOpen", "flashForward",
  "normalizeLoudness", "denoise", "muteSensitive", "sfx",
  "captionStyle", "speakerLabels", "translate", "subtitleFile",
  "publishCopy", "aiCover", "aigcLabel", "evidencePack", "publishPack", "packPlatforms",
  "jianyingDraft", "timeline", "compilation",
  "variants", "templateJitter",
] as const satisfies readonly (keyof RenderPrefs)[];

export type SchemeSnapshot = Pick<RenderPrefs, (typeof SCHEME_KEYS)[number]>;

export interface Scheme {
  id: string;
  name: string;
  /** 内置方案不可删除/覆盖。 */
  builtin?: boolean;
  prefs: SchemeSnapshot;
}

function snap(overrides: Partial<SchemeSnapshot> = {}): SchemeSnapshot {
  const out = {} as Record<string, unknown>;
  for (const k of SCHEME_KEYS) out[k] = RENDER_PREF_DEFAULTS[k];
  return { ...(out as SchemeSnapshot), ...overrides };
}

/** 内置三档:出厂默认 / 带货矩阵全开 / 只要最快出素材。 */
export const BUILTIN_SCHEMES: Scheme[] = [
  { id: "default", name: "默认出片", builtin: true, prefs: snap() },
  {
    id: "selling",
    name: "带货全家桶",
    builtin: true,
    prefs: snap({
      publishCopy: true,
      publishPack: true,
      aigcLabel: true,
      evidencePack: true,
      variants: 2,
      templateJitter: true,
      coldOpen: true,
      subtitleFile: true,
    }),
  },
  {
    id: "minimal",
    name: "极简省时",
    builtin: true,
    prefs: snap({
      titleCard: false,
      openingHook: false,
      cleanFillers: false,
      normalizeLoudness: false,
      trimUi: false,
      captionStyle: "none",
    }),
  },
];

/** 从当前偏好里抠出方案快照。纯函数。 */
export function snapshotOf(prefs: RenderPrefs): SchemeSnapshot {
  const out = {} as Record<string, unknown>;
  for (const k of SCHEME_KEYS) out[k] = prefs[k];
  return out as SchemeSnapshot;
}

/** 当前偏好与某方案是否一致(用于高亮「现在用的是哪个方案」)。纯函数。 */
export function matchesScheme(prefs: RenderPrefs, scheme: Scheme): boolean {
  return SCHEME_KEYS.every((k) => JSON.stringify(prefs[k]) === JSON.stringify(scheme.prefs[k]));
}

function loadUserSchemes(): Scheme[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
      .filter((s) => typeof s.id === "string" && typeof s.name === "string" && !!s.prefs && typeof s.prefs === "object")
      .map((s) => ({ id: s.id as string, name: (s.name as string).slice(0, 20), prefs: snap(s.prefs as Partial<SchemeSnapshot>) }));
  } catch {
    return [];
  }
}

interface SchemeState {
  userSchemes: Scheme[];
  saveCurrent: (name: string, prefs: RenderPrefs) => void;
  remove: (id: string) => void;
}

export const useSchemes = create<SchemeState>((set, get) => ({
  userSchemes: loadUserSchemes(),
  saveCurrent: (name, prefs) => {
    const scheme: Scheme = { id: `user-${Date.now()}`, name: name.slice(0, 20) || "我的方案", prefs: snapshotOf(prefs) };
    const userSchemes = [...get().userSchemes, scheme].slice(-8); // 上限 8 个,先进先出
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(userSchemes));
    } catch {
      /* 持久化尽力而为 */
    }
    set({ userSchemes });
  },
  remove: (id) => {
    const userSchemes = get().userSchemes.filter((s) => s.id !== id);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(userSchemes));
    } catch {
      /* 持久化尽力而为 */
    }
    set({ userSchemes });
  },
}));
