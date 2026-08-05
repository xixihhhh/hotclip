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

export interface LlmPreset {
  id: string;
  label: string;
  baseUrl: string;
  /** 出厂建议模型。模型 id 会随厂商换代失效——UI 上的「拉取模型」才是准的。 */
  model: string;
  /** 申请 key 的地址;本地端点为空。 */
  keyUrl: string;
}

/**
 * 供应商预设。base_url 都对着各家官方文档核过(2026-08);模型只是起点——
 * 厂商换代很快(deepseek-chat 已于 2026-07-24 下线),所以 UI 提供「拉取模型」
 * 直接问端点要真实清单,不指望这里的名字长期有效。
 */
export const LLM_PRESET_LIST: LlmPreset[] = [
  {
    id: "atlas",
    label: "Atlas Cloud",
    baseUrl: "https://api.atlascloud.ai/v1",
    model: "qwen/qwen3.5-flash",
    keyUrl: "https://www.atlascloud.ai",
  },
  {
    id: "deepseek",
    label: "DeepSeek 官方",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-v4-flash",
    keyUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "dashscope",
    label: "阿里云百炼(通义千问)",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    keyUrl: "https://bailian.console.aliyun.com/",
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    // 智谱的兼容路径就到 v4 为止,后面直接接 /chat/completions(不带 /v1)
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4.7",
    keyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
  },
  {
    id: "moonshot",
    label: "月之暗面 Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "kimi-k2.5",
    keyUrl: "https://platform.moonshot.cn/console/api-keys",
  },
  {
    id: "siliconflow",
    label: "硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "deepseek-ai/DeepSeek-V3",
    keyUrl: "https://cloud.siliconflow.cn/account/ak",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "deepseek/deepseek-v4-flash",
    keyUrl: "https://openrouter.ai/keys",
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.6-luna",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "ollama",
    label: "Ollama(本地)",
    baseUrl: "http://localhost:11434/v1",
    model: "qwen3:8b",
    keyUrl: "",
  },
];

/** 按 baseUrl 认出当前选的是哪家(用户改过 baseUrl 就认不出,返回 undefined)。 */
export function presetForBaseUrl(baseUrl: string): LlmPreset | undefined {
  return LLM_PRESET_LIST.find((p) => p.baseUrl === baseUrl);
}

/** 兼容旧引用:仍以 atlas 为默认。 */
export const LLM_PRESETS = { atlas: LLM_PRESET_LIST[0] } as const;

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
