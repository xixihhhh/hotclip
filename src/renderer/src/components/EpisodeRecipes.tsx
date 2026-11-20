import { useRef, useState } from "react";
import { episodeStructure, type EpisodeStructure } from "../../../shared/episode-structure";
import { useT } from "../i18n/store";
import { getApi } from "../api/provider";
import { activeBrandStyle, useBrandStore } from "../stores/brand-store";
import { useRenderPrefs } from "../stores/render-prefs-store";
import { useSession } from "../stores/session-store";
import { bindRecipe, loadRecipes, makeRecipe, parseRecipe, persistRecipes, recipeSettings, RECIPE_LIMIT_BYTES, type SavedRecipe } from "../stores/episode-recipes";

const BUTTON = "rounded-lg border border-line px-2.5 py-1 text-xs font-semibold hover:border-ember disabled:opacity-40";
const INPUT = "rounded-md border border-line bg-panel-2 px-2 py-1 text-xs text-fg";

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
  const item = list.find((entry) => entry.id === selected);

  function saveList(next: SavedRecipe[]) { persistRecipes(next); setList(next); }

  async function action(work: () => Promise<void>) {
    setBusy(true); setMessage("");
    try { await work(); } catch (err) { setMessage(err instanceof Error && err.message === "Invalid recipe" ? t("recipeInvalid") : t("recipeFailed")); }
    finally { setBusy(false); }
  }

  async function apply(nextSource: boolean, repick = false) {
    if (!item) return;
    const bound = await bindRecipe(item, getApi(), repick);
    if (!bound) { setMessage(t("recipeCancelled")); return; }
    if (repick) {
      saveList(list.map((entry) => entry.id === bound.id ? bound : entry));
      setMessage(t("recipeBound"));
      return;
    }
    if (nextSource && !await onNext()) return;
    const { prefs: changes, brand } = recipeSettings(bound);
    setPref(changes);
    useBrandStore.getState().activateSnapshot(bound.recipe.name, brand);
    useSession.getState().markParamsDirty(true);
    saveList(list.map((entry) => entry.id === bound.id ? bound : entry));
    setUseStructure(Boolean(changes.episode));
    if (changes.episode) setStructure(changes.episode);
    setMessage(t("recipeApplied"));
  }

  function saveCurrent() {
    const recipe = makeRecipe(name, { ...prefs, episode: useStructure ? structure : null }, activeBrandStyle(useBrandStore.getState()));
    saveList([...list, recipe]);
    select(recipe.id); setName(""); setMessage(t("recipeSaved"));
  }

  async function importFile(file?: File) {
    if (!file) return;
    if (file.size > RECIPE_LIMIT_BYTES) throw new Error("Invalid recipe");
    const imported = { id: crypto.randomUUID(), recipe: parseRecipe(await file.text()), musicPath: "", logoPath: "" };
    saveList([...list, imported]); select(imported.id); setMessage(t("recipeImported"));
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

  return <details className="my-2 w-full shrink-0 rounded-xl border border-line px-3 py-2 text-left text-xs">
    <summary className="cursor-pointer font-bold">{t("recipes")}</summary>
    <fieldset disabled={busy} className="mt-2 space-y-2">
      {canSave && <div className="space-y-2">
        <label className="flex gap-2"><input type="checkbox" checked={useStructure} onChange={(e) => setUseStructure(e.target.checked)} />{t("recipeStructure")}</label>
        {useStructure && <div className="flex flex-wrap items-center gap-2">
          {(["opening", "body", "ending"] as const).map((key) => <label key={key} className="flex items-center gap-1">{t("recipe_" + key)}
            <input className={INPUT + " w-14"} type="number" min="1" max="180" value={structure[key] || ""} onChange={(e) => setStructure({ ...structure, [key]: Number(e.target.value) })} /></label>)}
          <button className={BUTTON} onClick={useCutLength}>{t("recipeFromCut")}</button>
        </div>}
        <div className="flex flex-wrap gap-2"><input className={INPUT} aria-label={t("recipeName")} placeholder={t("recipeName")} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          <button className={BUTTON} onClick={() => void action(async () => saveCurrent())} disabled={!name.trim() || (useStructure && !episodeStructure(structure))}>{t("recipeSave")}</button>
        </div>
      </div>}
      <div className="flex flex-wrap items-center gap-2">
        {list.length > 0 && <select aria-label={t("recipes")} className={INPUT} value={selected} onChange={(e) => { select(e.target.value); setMessage(""); }}>
          {list.map((entry) => <option key={entry.id} value={entry.id}>{entry.recipe.name}</option>)}
        </select>}
        {item && <>{canSave && <button className={BUTTON} onClick={() => void action(() => apply(false))}>{t("recipeApply")}</button>}
          <button className={BUTTON} onClick={() => void action(() => apply(true))}>{t("recipeNext")}</button>
          <button className={BUTTON} onClick={download}>{t("recipeExport")}</button>
          {(item.recipe.assets.logo || item.recipe.assets.music) && <button className={BUTTON} onClick={() => void action(() => apply(false, true))}>{t("recipeRebind")}</button>}
        </>}
        <input ref={fileInput} type="file" accept=".json,application/json" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; void action(() => importFile(file)); }} />
        <button className={BUTTON} onClick={() => fileInput.current?.click()}>{t("recipeImport")}</button>
      </div>
      {item && (item.recipe.assets.logo || item.recipe.assets.music) && <p className="text-mut">{[item.recipe.assets.music, item.recipe.assets.logo?.name].filter(Boolean).join(" · ")}</p>}
      {message && <p role="status" className="text-mut">{message}</p>}
    </fieldset>
  </details>;
}
