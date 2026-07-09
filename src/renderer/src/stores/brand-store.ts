/**
 * 品牌样式预设 store(localStorage 持久化):多套命名预设 + 当前启用项。
 * "默认"预设 = 全部内置默认值(输出与历史版本逐字节一致),不可删除。
 */
import { create } from "zustand";
import type { BrandStyle } from "../../../shared/api-types";

const STORAGE_KEY = "hotclip-brand";

export interface BrandPreset {
  id: string;
  name: string;
  style: BrandStyle;
}

/** 内置"默认"预设:不带任何覆盖,管线走原有硬编码样式。名称由 i18n 渲染。 */
export const DEFAULT_PRESET: BrandPreset = { id: "default", name: "", style: {} };

/** 常用品牌色速选(UI 色板)。 */
export const SWATCHES = ["#FF6E0D", "#FF3355", "#FFD400", "#22C55E", "#38BDF8", "#A855F7"];

interface Persisted {
  presets: BrandPreset[];
  activeId: string;
}

function load(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Persisted>;
      if (Array.isArray(parsed.presets)) {
        const presets = parsed.presets.filter(
          (p): p is BrandPreset => Boolean(p && typeof p.id === "string" && typeof p.name === "string" && p.style)
        );
        const all = [DEFAULT_PRESET, ...presets.filter((p) => p.id !== "default")];
        const activeId = all.some((p) => p.id === parsed.activeId) ? (parsed.activeId as string) : "default";
        return { presets: all, activeId };
      }
    }
  } catch {
    /* 解析失败回落默认 */
  }
  return { presets: [DEFAULT_PRESET], activeId: "default" };
}

function persist(state: Persisted): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ presets: state.presets.filter((p) => p.id !== "default"), activeId: state.activeId })
    );
  } catch {
    /* 持久化尽力而为 */
  }
}

interface BrandState {
  presets: BrandPreset[];
  activeId: string;
  setActive: (id: string) => void;
  /** 更新当前预设的样式;对"默认"编辑时自动分叉成新预设。 */
  updateActiveStyle: (patch: Partial<BrandStyle>) => void;
  addPreset: (name: string) => void;
  removePreset: (id: string) => void;
  renameActive: (name: string) => void;
}

let seq = 0;
const newId = (): string => `p${Date.now().toString(36)}${(seq++).toString(36)}`;

export const useBrandStore = create<BrandState>((set, get) => ({
  ...load(),
  setActive: (id) => {
    const s = { presets: get().presets, activeId: id };
    persist(s);
    set(s);
  },
  updateActiveStyle: (patch) => {
    let { presets, activeId } = get();
    // "默认"是只读锚点:一改就分叉出"我的样式",默认永远可回退
    if (activeId === "default") {
      const fork: BrandPreset = { id: newId(), name: "我的样式", style: {} };
      presets = [...presets, fork];
      activeId = fork.id;
    }
    const next = presets.map((p) => {
      if (p.id !== activeId) return p;
      const style = { ...p.style, ...patch };
      // 显式传 undefined 表示清除该字段
      for (const k of Object.keys(patch) as (keyof BrandStyle)[]) {
        if (patch[k] === undefined) delete style[k];
      }
      return { ...p, style };
    });
    const s = { presets: next, activeId };
    persist(s);
    set(s);
  },
  addPreset: (name) => {
    const preset: BrandPreset = { id: newId(), name: name.trim() || "新预设", style: {} };
    const s = { presets: [...get().presets, preset], activeId: preset.id };
    persist(s);
    set(s);
  },
  removePreset: (id) => {
    if (id === "default") return;
    const presets = get().presets.filter((p) => p.id !== id);
    const activeId = get().activeId === id ? "default" : get().activeId;
    const s = { presets, activeId };
    persist(s);
    set(s);
  },
  renameActive: (name) => {
    const { presets, activeId } = get();
    if (activeId === "default" || !name.trim()) return;
    const s = {
      presets: presets.map((p) => (p.id === activeId ? { ...p, name: name.trim() } : p)),
      activeId,
    };
    persist(s);
    set(s);
  },
}));

/** 当前生效的品牌样式(给导出用;默认预设返回 undefined = 不覆盖)。 */
export function activeBrandStyle(state: Pick<BrandState, "presets" | "activeId">): BrandStyle | undefined {
  const preset = state.presets.find((p) => p.id === state.activeId);
  if (!preset || preset.id === "default") return undefined;
  return Object.keys(preset.style).length > 0 ? preset.style : undefined;
}
