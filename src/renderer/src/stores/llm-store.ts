/**
 * LLM connection settings (persisted to localStorage).
 * Presets: Atlas Cloud (recommended default), Ollama local, custom.
 */
import { create } from "zustand";
import type { LlmConfig } from "../../../shared/api-types";

const STORAGE_KEY = "hotclip-llm";
const PREFILTER_KEY = "hotclip-prefilter";
const VISION_KEY = "hotclip-vision";

/** 两级漏斗第一级的本地端点设置(默认 Ollama + qwen3:4b,默认关)。 */
export interface PrefilterSettings {
  enabled: boolean;
  baseUrl: string;
  model: string;
}

export const PREFILTER_DEFAULTS: PrefilterSettings = {
  enabled: false,
  baseUrl: "http://localhost:11434/v1",
  model: "qwen3:4b",
};

/** 视觉爆点信号的端侧 VL 端点设置(默认 Ollama + qwen3-vl:4b,默认关)。 */
export const VISION_DEFAULTS: PrefilterSettings = {
  enabled: false,
  baseUrl: "http://localhost:11434/v1",
  model: "qwen3-vl:4b",
};

function loadLocalEndpoint(key: string, defaults: PrefilterSettings): PrefilterSettings {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const p = JSON.parse(raw) as Partial<PrefilterSettings>;
      return {
        enabled: p.enabled === true,
        baseUrl: typeof p.baseUrl === "string" && p.baseUrl ? p.baseUrl : defaults.baseUrl,
        model: typeof p.model === "string" && p.model ? p.model : defaults.model,
      };
    }
  } catch {
    /* 回落默认 */
  }
  return { ...defaults };
}

export const LLM_PRESETS = {
  atlas: {
    label: "Atlas Cloud",
    baseUrl: "https://api.atlascloud.ai/v1",
    model: "qwen/qwen3.5-flash",
    keyUrl: "https://www.atlascloud.ai",
  },
  ollama: {
    label: "Ollama (本地)",
    baseUrl: "http://localhost:11434/v1",
    model: "qwen3:8b",
    keyUrl: "",
  },
} as const;

function load(): LlmConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LlmConfig>;
      if (typeof parsed.baseUrl === "string" && typeof parsed.model === "string") {
        return { baseUrl: parsed.baseUrl, apiKey: parsed.apiKey ?? "", model: parsed.model };
      }
    }
  } catch {
    /* fall through to defaults */
  }
  return { baseUrl: LLM_PRESETS.atlas.baseUrl, apiKey: "", model: LLM_PRESETS.atlas.model };
}

interface LlmState {
  config: LlmConfig;
  setConfig: (partial: Partial<LlmConfig>) => void;
  prefilter: PrefilterSettings;
  setPrefilter: (partial: Partial<PrefilterSettings>) => void;
  vision: PrefilterSettings;
  setVision: (partial: Partial<PrefilterSettings>) => void;
}

export const useLlmStore = create<LlmState>((set, get) => ({
  config: load(),
  setConfig: (partial) => {
    const config = { ...get().config, ...partial };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch {
      /* persistence is best-effort */
    }
    set({ config });
  },
  prefilter: loadLocalEndpoint(PREFILTER_KEY, PREFILTER_DEFAULTS),
  setPrefilter: (partial) => {
    const prefilter = { ...get().prefilter, ...partial };
    try {
      localStorage.setItem(PREFILTER_KEY, JSON.stringify(prefilter));
    } catch {
      /* persistence is best-effort */
    }
    set({ prefilter });
  },
  vision: loadLocalEndpoint(VISION_KEY, VISION_DEFAULTS),
  setVision: (partial) => {
    const vision = { ...get().vision, ...partial };
    try {
      localStorage.setItem(VISION_KEY, JSON.stringify(vision));
    } catch {
      /* persistence is best-effort */
    }
    set({ vision });
  },
}));

/** Ready = enough fields to attempt a call (Ollama needs no key). */
export function isLlmReady(config: LlmConfig): boolean {
  const needsKey = !/localhost|127\.0\.0\.1/.test(config.baseUrl);
  return Boolean(config.baseUrl && config.model && (!needsKey || config.apiKey));
}
