import { LuLayers, LuUpload, LuDownload, LuArrowRight } from "react-icons/lu";
import { useEffect, useRef, useState } from "react";
import { episodeStructure, type EpisodeStructure } from "../../../shared/episode-structure";
import { useT } from "../i18n/store";
import { getApi } from "../api/provider";
import { activeBrandStyle, useBrandStore } from "../stores/brand-store";
import { useRenderPrefs } from "../stores/render-prefs-store";
import { useSession } from "../stores/session-store";
import { assetFilename, assetPath, bindRecipeAsset, missingRecipeAssets, requiredAsset, RECIPE_ASSETS, type RecipeAsset, loadRecipes, makeRecipe, parseRecipe, persistRecipes, recipeSettings, RECIPE_LIMIT_BYTES, type SavedRecipe } from "../stores/episode-recipes";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ember";
const BUTTON = FOCUS + " rounded-lg border border-line px-2.5 py-1 text-xs font-semibold hover:border-ember disabled:opacity-40";


export function EpisodeRecipes({ onNext, canSave = false }: { onNext: () => Promise<boolean>; canSave?: boolean }) {
  const t = useT("workbench");
  const { prefs, setPref } = useRenderPrefs();
  const [list, setList] = useState(loadRecipes);
  const [selected, select] = useState(() => list[0]?.id ?? "");
  const [name, setName] = useState("");
  const [structure, setStructure] = useState<EpisodeStructure>(prefs.episode ?? { opening: 5, body: 20, ending: 5 });
  const [useStructure, setUseStructure] = useState(Boolean(prefs.episode));
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const assetButtons = useRef<Partial<Record<RecipeAsset, HTMLButtonElement | null>>>({});
  const selectRef = useRef<HTMLSelectElement>(null);
  const [focusTarget, setFocusTarget] = useState<RecipeAsset | "select" | null>(null);
  const [unavailable, setUnavailable] = useState<RecipeAsset[]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (busy || !focusTarget) return;
    const control = focusTarget === "select" ? selectRef.current : assetButtons.current[focusTarget];
    control?.focus();
    setFocusTarget(null);
  }, [busy, focusTarget]);
  const item = list.find((entry) => entry.id === selected);

  function saveList(next: SavedRecipe[]) { persistRecipes(next); setList(next); }

  async function action(work: () => Promise<void>) {
    setBusy(true); setMessage(""); setFailed(false);
    try { await work(); } catch (err) { setFailed(true); setMessage(err instanceof Error && err.message === "Invalid recipe" ? t("recipeInvalid") : t("recipeFailed")); }
    finally { setBusy(false); }
  }

  async function chooseAsset(kind: RecipeAsset) {
    if (!item) return;
    setFocusTarget(kind);
    try {
      const bound = await bindRecipeAsset(item, kind, getApi());
      if (!bound) {
        setMessage(t(kind === "music" ? "recipeMusicCancelled" : "recipeLogoCancelled"));
        return;
      }
      saveList(list.map((entry) => entry.id === bound.id ? bound : entry));
      setUnavailable((old) => old.filter((asset) => asset !== kind));
      setMessage(t(kind === "music" ? "recipeMusicReady" : "recipeLogoReady", { name: assetFilename(assetPath(bound, kind)) }));
    } catch {
      setFailed(true);
      setMessage(t(kind === "music" ? "recipeMusicFailed" : "recipeLogoFailed"));
    }
  }

  async function apply(nextSource: boolean) {
    if (!item) return;
    const missing = await missingRecipeAssets(item, getApi());
    setUnavailable(missing);
    if (missing.length) {
      setFailed(true);
      setFocusTarget(missing[0]);
      setMessage(t("recipeNeedsAsset", { assets: missing.map((k) => t(k === "music" ? "recipeMusic" : "recipeLogo")).join(" / ") }));
      return;
    }
    if (nextSource && !await onNext()) return;
    const bound = item;
    const { prefs: changes, brand } = recipeSettings(bound);
    setPref(changes);
    useBrandStore.getState().activateSnapshot(bound.recipe.name, brand);
    useSession.getState().markParamsDirty(true);
    setUseStructure(Boolean(changes.episode));
    if (changes.episode) setStructure(changes.episode);
    setMessage(t("recipeApplied"));
  }

  function saveCurrent() {
    const recipe = makeRecipe(name, { ...prefs, episode: useStructure ? structure : null }, activeBrandStyle(useBrandStore.getState()));
    saveList([...list, recipe]);
    select(recipe.id); setUnavailable([]); setFocusTarget("select"); setName(""); setMessage(t("recipeSaved"));
  }

  async function importFile(file?: File) {
    if (!file) return;
    if (file.size > RECIPE_LIMIT_BYTES) throw new Error("Invalid recipe");
    const imported = { id: crypto.randomUUID(), recipe: parseRecipe(await file.text()), musicPath: "", logoPath: "" };
    saveList([...list, imported]); select(imported.id); setUnavailable([]); setFocusTarget("select"); setMessage(t("recipeImported"));
  }

  function download() {
    if (!item) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(item.recipe, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url;
    a.download = item.recipe.name.replace(/[\\/:*?"<>|]/g, "-") + ".hotclip.json";
    a.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function useCutLength() {
    const session = useSession.getState();
    const cut = session.candidates?.find((c) => c.id === session.focusedId) ?? session.candidates?.find((c) => session.selected.has(c.id));
    if (!cut) { setMessage(t("recipeNoCut")); return; }
    const spans = (cut.pieces?.length ? cut.pieces : [cut]).map((p) => p.endSec - p.startSec);
    const total = spans.reduce((sum, sec) => sum + sec, 0);
    const values = spans.length >= 3 ? [spans[0], total - spans[0] - spans.at(-1)!, spans.at(-1)!] : [total * .2, total * .6, total * .2];
    const [opening, body, ending] = values.map((v) => Math.max(1, Math.min(180, Math.round(v))));
    setStructure({ opening, body, ending }); setUseStructure(true);
    setMessage(spans.length >= 3 ? t("recipeReadParts") : t("recipeEstimated"));
  }

  return <section className={canSave ? "recipe-editor" : "recipe-home"}>
    <h2><LuLayers aria-hidden="true" size={18} />{t(canSave ? "recipes" : "recipeHome")}</h2>
    <fieldset disabled={busy}>
      {item ? <div className="recipe-selection">
        <label>{t("deskRecipeSelect")}
          <select ref={selectRef} aria-label={t("recipes")} value={selected} onChange={(e) => {
            select(e.target.value); setUnavailable([]); setFailed(false); setMessage("");
          }}>{list.map((entry) => <option key={entry.id} value={entry.id}>{entry.recipe.name}</option>)}</select>
        </label>
      </div> : <p className="recipe-empty">{t("deskRecipeEmpty")}</p>}
      {item && RECIPE_ASSETS.map((kind) => {
        const expected = requiredAsset(item, kind);
        if (!expected) return null;
        const label = t(kind === "music" ? "recipeMusic" : "recipeLogo");
        const path = assetPath(item, kind);
        const missing = !path || unavailable.includes(kind);
        return <div key={kind} className="recipe-asset-row">
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-fg">{label}</p>
            <p className="break-all text-mut">{t("recipeExpected", { name: expected })}</p>
            <p className={missing ? "break-all font-medium text-amber-400" : "break-all text-fg"} title={path || undefined}>
              {path ? t(missing ? "recipeMissingFile" : "recipeBoundFile", { name: assetFilename(path) }) : t("recipeUnbound")}
            </p>
          </div>
          <button type="button" className={BUTTON} ref={(button) => { assetButtons.current[kind] = button; }}
            onClick={() => void action(() => chooseAsset(kind))}>
            {t(missing ? "recipeBindOne" : "recipeChangeOne", { asset: label })}
          </button>
        </div>;
      })}
      {item && <div className="recipe-run">
        <button type="button" className="desk-primary" onClick={() => void action(() => apply(true))}>{t("recipeNext")}<LuArrowRight size={15} aria-hidden="true" /></button>
        {canSave && <button type="button" className="desk-secondary" onClick={() => void action(() => apply(false))}>{t("recipeApply")}</button>}
      </div>}
      <div className="recipe-files">
        <input ref={fileInput} type="file" accept=".json,application/json" className="hidden" onChange={(e) => {
          const file = e.target.files?.[0]; e.target.value = ""; void action(() => importFile(file));
        }} />
        <button type="button" className={item ? "desk-quiet" : "desk-secondary"} onClick={() => fileInput.current?.click()}>
          <LuUpload size={15} aria-hidden="true" />{t("recipeImport")}</button>
        {item && <button type="button" className="desk-quiet" onClick={download}><LuDownload size={15} aria-hidden="true" />{t("recipeExport")}</button>}
      </div>
      {canSave && <details className="recipe-save" open={!item || undefined}>
        <summary>{t("recipeSave")}</summary>
        <div className="recipe-save-form">
          <label className="recipe-check"><input type="checkbox" checked={useStructure} onChange={(e) => setUseStructure(e.target.checked)} />{t("recipeStructure")}</label>
          {useStructure && <div className="recipe-times">
            {(["opening","body","ending"] as const).map((key) => <label key={key}>{t("recipe_"+key)}<input type="number" min="1" max="180" value={structure[key] || ""}
              onChange={(e) => setStructure({ ...structure, [key]: Number(e.target.value) })} /></label>)}
            <button type="button" className="desk-quiet" onClick={useCutLength}>{t("recipeFromCut")}</button>
          </div>}
          <div className="scheme-tools"><input aria-label={t("recipeName")} placeholder={t("recipeName")} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
            <button type="button" className="desk-secondary" onClick={() => void action(async () => saveCurrent())}
              disabled={!name.trim() || (useStructure && !episodeStructure(structure))}>{t("recipeSave")}</button></div>
        </div>
      </details>}
      {message && <p role={failed ? "alert" : "status"} className={failed ? "desk-error" : "recipe-message"}>{message}</p>}
    </fieldset>
  </section>;
}
