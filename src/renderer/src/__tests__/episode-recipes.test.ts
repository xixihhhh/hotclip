import { expect, it, vi } from "vitest";
import { bindRecipe, makeRecipe, parseRecipe, recipeSettings } from "../stores/episode-recipes";
import { RENDER_PREF_DEFAULTS } from "../stores/render-prefs-store";
import { snapshotOf } from "../stores/scheme-store";
import { buildRenderToggles } from "../components/workbench/export-options";

const prefs = { ...RENDER_PREF_DEFAULTS, bgmPath: "/private/show-a/upbeat.mp3", outDir: "/private/renders", captionStyle: "minimal" as const,
  gameCameraEnabled: true, maxClips: 2, briefFocus: "final score", genreId: "gaming", episode: { opening: 3, body: 12, ending: 4 } };
const brand = { highlightColor: "#FF0000", titleStyle: "brandPlate" as const, watermark: { path: "C:\\channel\\mark.png", corner: "top-left" as const, opacity: 0.6 } };

it("restores the complete column after a different column was active", () => {
  const saved = makeRecipe("比赛夜", prefs, brand);
  const changed = { ...RENDER_PREF_DEFAULTS, bgmPath: "slow.mp3", outDir: "current-out", maxClips: 9 };
  const restored = recipeSettings(saved);
  const nextPrefs = { ...changed, ...restored.prefs };
  const opts = buildRenderToggles({ prefs: nextPrefs, brandState: { activeId: "red", presets: [{ id: "red", name: "show", style: restored.brand }] },
    config: { baseUrl: "local", model: "m", apiKey: "" }, transcript: null, diarize: false, atlasReady: false });
  expect(opts).toMatchObject({ captionStyle: "minimal", brand, bgmPath: prefs.bgmPath, gameCamera: prefs.cameraRegion, outDir: "current-out" });
  expect(nextPrefs).toMatchObject({ maxClips: 2, genreId: "gaming", briefFocus: "final score", episode: prefs.episode });
  expect(snapshotOf(prefs)).not.toHaveProperty("episode");
});

it("exports only asset basenames, rebinds on a second machine, and rejects unsupported formats", async () => {
  const saved = makeRecipe("A", prefs, brand);
  const raw = JSON.stringify(saved.recipe);
  for (const secret of ["/private", "C:", "outDir", "apiKey", "bgmPath"]) expect(raw).not.toContain(secret);
  const portable = parseRecipe(raw);
  expect(portable.assets).toEqual({ music: "upbeat.mp3", logo: { name: "mark.png", corner: "top-left", opacity: 0.6 } });
  const api = { probeMedia: vi.fn(), selectAudio: vi.fn(async () => "/new/bg.mp3"), selectImage: vi.fn(async () => "/new/logo.png") };
  const fresh = { ...saved, recipe: portable, musicPath: "", logoPath: "" };
  const bound = await bindRecipe(fresh, api);
  expect(recipeSettings(bound!)).toMatchObject({ prefs: { bgmPath: "/new/bg.mp3" }, brand: { watermark: { path: "/new/logo.png" } } });
  expect(api.probeMedia).not.toHaveBeenCalled();
  expect(await bindRecipe(fresh, { ...api, selectImage: async () => null })).toBeNull();
  expect(() => parseRecipe('{"version":2}')).toThrow();
  expect(() => parseRecipe(JSON.stringify({ ...portable, settings: { ...portable.settings, episode: { opening: -2 } } }))).toThrow();
});
