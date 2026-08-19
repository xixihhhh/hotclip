/**
 * 底部出片栏:已选统计 + 变形度预估 + 方案切换 + 导出目录 + 出片按钮。
 * 33 个开关不再铺屏——常用的走方案一键切,全量选项在「全部选项」面板里。
 */
import { LuFolderOpen, LuScissors, LuSlidersHorizontal } from "react-icons/lu";
import { useT } from "../../i18n/store";
import { getApi, isElectron } from "../../api/provider";
import { useSession } from "../../stores/session-store";
import { useRenderPrefs } from "../../stores/render-prefs-store";
import { useSchemes, BUILTIN_SCHEMES, matchesScheme } from "../../stores/scheme-store";
import { useBrandStore, activeBrandStyle } from "../../stores/brand-store";
import { transformScore } from "../../../../shared/transform-score";
import { clipDurationSec } from "../../../../shared/pieces";

export function ExportBar({
  defaultOutDir,
  onExport,
  onOpenPanel,
}: {
  defaultOutDir: string;
  onExport: () => void;
  onOpenPanel: () => void;
}): React.JSX.Element {
  const t = useT("workbench");
  const th = useT("highlights");
  const { prefs, setPref } = useRenderPrefs();
  const { userSchemes } = useSchemes();
  const brandState = useBrandStore();
  const { candidates, selected } = useSession();
  const picked = (candidates ?? []).filter((c) => selected.has(c.id));
  const totalSec = Math.round(picked.reduce((a, c) => a + clipDurationSec(c), 0));

  const schemes = [...BUILTIN_SCHEMES, ...userSchemes];
  const active = schemes.find((s) => matchesScheme(prefs, s));

  const est = transformScore({
    vertical: prefs.vertical,
    captions: prefs.captionStyle !== "none",
    recut: prefs.jumpCut || prefs.cleanFillers || prefs.cutRetakes,
    reopened: prefs.coldOpen || prefs.flashForward,
    titleOverlay: prefs.titleCard || prefs.openingHook,
    autoZoom: prefs.autoZoom && prefs.vertical,
    bgm: Boolean(prefs.bgmPath),
    sfx: prefs.sfx,
    stitched: false,
    translated: prefs.translate,
    watermark: Boolean(activeBrandStyle(brandState)?.watermark),
  });

  const pickOutDir = async (): Promise<void> => {
    const dir = await getApi().selectDir();
    if (dir) setPref({ outDir: dir });
  };

  return (
    <div className="flex h-12 shrink-0 items-center gap-3 border-t border-line/70 bg-panel/70 px-4 backdrop-blur">
      <span className="shrink-0 text-[12px] font-semibold text-fg/90">{t("exportBarSelected", { n: picked.length, sec: totalSec })}</span>
      <span
        title={est.level === "warn" ? th("transformWarnHint", { miss: est.missingTop.map((k) => th(`tf_${k}`)).join("/") }) : th("transformHint")}
        className={`shrink-0 rounded-md px-2 py-0.5 text-[10.5px] font-bold ${
          est.level === "warn" ? "border border-amber-500/40 bg-amber-500/10 text-amber-400" : "chip text-mut"
        }`}
      >
        {th("transformChip", { n: est.score })}
      </span>
      {picked.length > 5 && <span className="hidden shrink-0 text-[10.5px] text-amber-400/90 lg:block">{th("overCapHint", { n: picked.length })}</span>}
      <span className="min-w-0 flex-1" />
      {/* 方案切换:选中即应用整组开关 */}
      <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-mut">
        {t("schemeLabel")}
        <select
          value={active?.id ?? "__custom"}
          onChange={(e) => {
            const s = schemes.find((x) => x.id === e.target.value);
            if (s) setPref({ ...s.prefs });
          }}
          className="rounded-lg border border-line bg-panel-2 px-2 py-1.5 text-[11.5px] font-semibold text-fg outline-none focus:border-ember/60"
        >
          {!active && <option value="__custom">{t("schemeCustom")}</option>}
          {schemes.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        onClick={onOpenPanel}
        className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[11.5px] font-semibold text-mut transition-colors hover:border-mut hover:text-fg"
      >
        <LuSlidersHorizontal className="h-3.5 w-3.5" />
        {t("openExportPanel")}
      </button>
      <span className="hidden max-w-52 shrink-0 items-center gap-1 text-[10.5px] text-mut/70 xl:flex">
        <LuFolderOpen className="h-3 w-3 shrink-0" />
        <span className="truncate" title={prefs.outDir || defaultOutDir}>
          {(prefs.outDir || defaultOutDir || "…").split(/[\\/]/).slice(-2).join("/")}
        </span>
        {isElectron() && (
          <button type="button" onClick={() => void pickOutDir()} className="shrink-0 font-semibold text-ember/80 underline-offset-2 hover:underline">
            {th("outDirChange")}
          </button>
        )}
      </span>
      <button
        type="button"
        disabled={picked.length === 0}
        onClick={onExport}
        className="btn-flame flex h-8.5 shrink-0 items-center gap-1.5 rounded-lg px-5 text-[13px] font-extrabold whitespace-nowrap text-white disabled:opacity-40"
      >
        <LuScissors className="h-4 w-4" />
        {t("startExport", { n: picked.length })}
      </button>
    </div>
  );
}
