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
export const assetFilename = (value: string): string => value.split(/[\\/]/).pop()?.trim().slice(0, 200) || "";

export function makeRecipe(name: string, prefs: RenderPrefs, source?: BrandStyle): SavedRecipe {
  const { bgmPath, outDir: _outDir, ...settings } = normalizeRenderPrefs(prefs);
  const { watermark, ...brand } = sanitizeBrand(source) ?? {};
  const recipe: Recipe = {
    format: "hotclip-episode", version: 1, name: name.trim().slice(0, 80), settings, brand,
    assets: {
      ...(bgmPath ? { music: assetFilename(bgmPath) } : {}),
      ...(watermark ? { logo: { name: assetFilename(watermark.path), corner: watermark.corner, opacity: watermark.opacity } } : {}),
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
      (logo !== undefined && (!logo || typeof logo.name !== "string" || !assetFilename(logo.name)))) throw new Error("Invalid recipe");
  const clean = makeRecipe(value.name, { ...prefs, outDir: "", bgmPath: assetFilename(value.assets.music ?? "") }, {
    ...brand, ...(logo ? { watermark: { path: assetFilename(logo.name), corner: logo.corner, opacity: logo.opacity } } : {}),
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

export type RecipeAsset = "music" | "logo";
export const RECIPE_ASSETS: readonly RecipeAsset[] = ["music", "logo"];
type AssetApi = {
  probeMedia: (path: string) => Promise<unknown>;
  selectAudio: () => Promise<string | null>;
  selectImage: () => Promise<string | null>;
};

export function requiredAsset(saved: SavedRecipe, kind: RecipeAsset): string | undefined {
  return kind === "music" ? saved.recipe.assets.music : saved.recipe.assets.logo?.name;
}

export function assetPath(saved: SavedRecipe, kind: RecipeAsset): string {
  return kind === "music" ? saved.musicPath : saved.logoPath;
}

export async function missingRecipeAssets(saved: SavedRecipe, api: Pick<AssetApi, "probeMedia">): Promise<RecipeAsset[]> {
  const missing: RecipeAsset[] = [];
  for (const kind of RECIPE_ASSETS) {
    if (!requiredAsset(saved, kind)) continue;
    const path = assetPath(saved, kind);
    if (path) {
      try { await api.probeMedia(path); continue; } catch { /* a moved file needs a new binding */ }
    }
    missing.push(kind);
  }
  return missing;
}

export async function bindRecipeAsset(saved: SavedRecipe, kind: RecipeAsset, api: AssetApi): Promise<SavedRecipe | null> {
  const path = await (kind === "music" ? api.selectAudio() : api.selectImage());
  if (!path) return null;
  await api.probeMedia(path);
  return kind === "music" ? { ...saved, musicPath: path } : { ...saved, logoPath: path };
}

export function recipeSettings(saved: SavedRecipe) {
  const { recipe, musicPath, logoPath } = saved;
  const logo = recipe.assets.logo;
  const brand = sanitizeBrand({ ...recipe.brand, watermark: logo && { ...logo, path: logoPath } }) ?? {};
  return { prefs: { ...recipe.settings, bgmPath: musicPath }, brand };
}
