import type { BrandStyle } from "../../../shared/api-types";
import { sanitizeBrand } from "../../../shared/brand-style";
import { episodeStructure } from "../../../shared/episode-structure";
import { normalizeRenderPrefs, type RenderPrefs } from "./render-prefs-store";

type RecipePrefs = Omit<RenderPrefs, "bgmPath" | "outDir">;
export interface Recipe {
  format: "hotclip-episode";
  version: 1;
  name: string;
  settings: RecipePrefs;
  brand: Omit<BrandStyle, "watermark">;
  assets: { music?: string; logo?: { name: string; corner: string; opacity: number } };
}
export interface SavedRecipe { id: string; recipe: Recipe; musicPath: string; logoPath: string }
export const RECIPE_LIMIT_BYTES = 256 * 1024;
const KEY = "hotclip-episode-recipes-v1";
const basename = (value: string): string => value.split(/[\\/]/).pop()?.trim().slice(0, 200) || "";

export function makeRecipe(name: string, prefs: RenderPrefs, source?: BrandStyle): SavedRecipe {
  const { bgmPath, outDir: _outDir, ...settings } = normalizeRenderPrefs(prefs);
  const { watermark, ...brand } = sanitizeBrand(source) ?? {};
  const recipe: Recipe = {
    format: "hotclip-episode", version: 1, name: name.trim().slice(0, 80), settings, brand,
    assets: {
      ...(bgmPath ? { music: basename(bgmPath) } : {}),
      ...(watermark ? { logo: { name: basename(watermark.path), corner: watermark.corner, opacity: watermark.opacity } } : {}),
    },
  };
  return { id: crypto.randomUUID(), recipe, musicPath: bgmPath, logoPath: watermark?.path ?? "" };
}

export function parseRecipe(raw: string): Recipe {
  if (raw.length > RECIPE_LIMIT_BYTES) throw new Error("Invalid recipe");
  const value = JSON.parse(raw);
  if (value?.format !== "hotclip-episode" || value.version !== 1 || typeof value.name !== "string" ||
      !value.name.trim() || !value.settings || typeof value.settings !== "object" || Array.isArray(value.settings) ||
      !value.assets || typeof value.assets !== "object" || !value.brand || typeof value.brand !== "object") throw new Error("Invalid recipe");
  if (value.settings.episode != null && !episodeStructure(value.settings.episode)) throw new Error("Invalid recipe");
  const prefs = normalizeRenderPrefs(value.settings);
  const { watermark: _unused, ...brand } = sanitizeBrand(value.brand) ?? {};
  const logo = value.assets.logo;
  if ((value.assets.music !== undefined && typeof value.assets.music !== "string") ||
      (logo !== undefined && (!logo || typeof logo.name !== "string" || !basename(logo.name)))) throw new Error("Invalid recipe");
  const clean = makeRecipe(value.name, { ...prefs, outDir: "", bgmPath: basename(value.assets.music ?? "") }, {
    ...brand, ...(logo ? { watermark: { path: basename(logo.name), corner: logo.corner, opacity: logo.opacity } } : {}),
  });
  return clean.recipe;
}

export function loadRecipes(): SavedRecipe[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(list)) return [];
    return list.flatMap((entry) => {
      try {
        if (typeof entry?.id !== "string") return [];
        return [{ id: entry.id, recipe: parseRecipe(JSON.stringify(entry.recipe)),
          musicPath: typeof entry.musicPath === "string" ? entry.musicPath : "",
          logoPath: typeof entry.logoPath === "string" ? entry.logoPath : "" }];
      } catch { return []; }
    });
  } catch { return []; }
}
export function persistRecipes(list: SavedRecipe[]): void {
  localStorage.setItem(KEY, JSON.stringify(list));
}

export async function bindRecipe(saved: SavedRecipe, api: {
  probeMedia: (path: string) => Promise<unknown>;
  selectAudio: () => Promise<string | null>;
  selectImage: () => Promise<string | null>;
}, repick = false): Promise<SavedRecipe | null> {
  async function bind(name: string | undefined, path: string, pick: () => Promise<string | null>) {
    if (!name) return "";
    if (path && !repick) {
      try { await api.probeMedia(path); return path; } catch { /* a moved asset needs rebinding */ }
    }
    return pick();
  }
  const musicPath = await bind(saved.recipe.assets.music, saved.musicPath, () => api.selectAudio());
  if (musicPath === null) return null;
  const logoPath = await bind(saved.recipe.assets.logo?.name, saved.logoPath, () => api.selectImage());
  if (logoPath === null) return null;
  return { ...saved, musicPath, logoPath };
}

export function recipeSettings(saved: SavedRecipe) {
  const { recipe, musicPath, logoPath } = saved;
  const logo = recipe.assets.logo;
  const brand = sanitizeBrand({ ...recipe.brand, watermark: logo && { ...logo, path: logoPath } }) ?? {};
  return { prefs: { ...recipe.settings, bgmPath: musicPath }, brand };
}
