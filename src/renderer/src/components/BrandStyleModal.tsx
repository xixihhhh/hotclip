/**
 * 品牌样式模板:高亮色/字号/字幕位置/logo 水印,一次配置每条切片复用。
 * 多套命名预设持久化在本机;"默认"预设只读,一改自动分叉,永远可回退。
 * 右侧 9:16 迷你画布实时预览当前参数的成片效果。
 */
import { useState } from "react";
import { LuPalette, LuX, LuPlus, LuTrash2, LuImage, LuCheck } from "react-icons/lu";
import { useT } from "../i18n/store";
import { getApi } from "../api/provider";
import { useBrandStore, activeBrandStyle, SWATCHES } from "../stores/brand-store";
import type { BrandStyle, BrandWatermark } from "../../../shared/api-types";
import { ModalShell } from "./ui";

/** 迷你预览里字幕基线位置(与管线三档 marginV 倍率一致换算)。 */
const PREVIEW_BASELINE: Record<string, string> = { low: "78%", standard: "70.8%", high: "63.5%" };

function fileBase(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function BrandStyleModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const t = useT("brand");
  const { presets, activeId, setActive, updateActiveStyle, addPreset, removePreset } = useBrandStore();
  const active = presets.find((p) => p.id === activeId) ?? presets[0];
  const style: BrandStyle = active.style;
  const [picking, setPicking] = useState(false);

  const highlight = style.highlightColor ?? "#FF6E0D";
  const fontScale = style.fontScale ?? 1;
  const position = style.captionPosition ?? "standard";
  const wm = style.watermark;

  const setWatermark = (patch: Partial<BrandWatermark> | null): void => {
    if (patch === null) {
      updateActiveStyle({ watermark: undefined });
      return;
    }
    const base: BrandWatermark = wm ?? { path: "", corner: "top-right", opacity: 0.85 };
    updateActiveStyle({ watermark: { ...base, ...patch } });
  };

  const pickLogo = async (): Promise<void> => {
    setPicking(true);
    try {
      const path = await getApi().selectImage();
      if (path) setWatermark({ path });
    } finally {
      setPicking(false);
    }
  };

  const chip = (selected: boolean): string =>
    `rounded-lg border px-3 py-1.5 text-[12px] font-semibold transition-colors ${
      selected ? "border-ember/60 bg-ember/10 text-fg" : "border-line text-mut hover:border-mut hover:text-fg"
    }`;

  return (
    <ModalShell onClose={onClose}>
      <div
        className="card rise-in flex max-h-[92vh] w-full max-w-3xl flex-col overflow-y-auto rounded-2xl p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-extrabold tracking-tight">
              <LuPalette className="h-4.5 w-4.5 text-ember" />
              {t("title")}
            </h2>
            <p className="mt-0.5 text-[12.5px] text-mut">{t("desc")}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-line p-1.5 text-mut transition-colors hover:border-mut hover:text-fg"
          >
            <LuX className="h-4 w-4" />
          </button>
        </div>

        {/* 预设切换 */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {presets.map((p) => (
            <button key={p.id} type="button" onClick={() => setActive(p.id)} className={chip(p.id === activeId)}>
              {p.id === "default" ? t("defaultPreset") : p.name}
            </button>
          ))}
          <button
            type="button"
            onClick={() => addPreset(t("newPresetName"))}
            title={t("addPreset")}
            className="rounded-lg border border-dashed border-line p-1.5 text-mut transition-colors hover:border-mut hover:text-fg"
          >
            <LuPlus className="h-3.5 w-3.5" />
          </button>
          {activeId !== "default" && (
            <button
              type="button"
              onClick={() => removePreset(activeId)}
              title={t("removePreset")}
              className="rounded-lg border border-line p-1.5 text-mut transition-colors hover:border-red-400 hover:text-red-400"
            >
              <LuTrash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div className="mt-4 flex gap-5">
          {/* 左:参数 */}
          <div className="min-w-0 flex-1 space-y-4">
            {/* 高亮色 */}
            <section>
              <h3 className="text-[12px] font-bold text-mut">{t("highlight")}</h3>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {SWATCHES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => updateActiveStyle({ highlightColor: c })}
                    className={`flex h-7 w-7 items-center justify-center rounded-full border-2 transition-transform hover:scale-110 ${
                      highlight.toUpperCase() === c ? "border-fg" : "border-transparent"
                    }`}
                    style={{ background: c }}
                  >
                    {highlight.toUpperCase() === c && <LuCheck className="h-3.5 w-3.5 text-white drop-shadow" />}
                  </button>
                ))}
                {/* 自定义取色 */}
                <label
                  className="relative flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-line px-2 text-[11px] text-mut transition-colors hover:border-mut hover:text-fg"
                  title={t("customColor")}
                >
                  <span className="h-3.5 w-3.5 rounded-full" style={{ background: highlight }} />
                  {highlight.toUpperCase()}
                  <input
                    type="color"
                    value={highlight}
                    onChange={(e) => updateActiveStyle({ highlightColor: e.target.value.toUpperCase() })}
                    className="absolute inset-0 cursor-pointer opacity-0"
                  />
                </label>
              </div>
            </section>

            {/* 字号 */}
            <section>
              <h3 className="text-[12px] font-bold text-mut">{t("fontSize")}</h3>
              <div className="mt-2 flex gap-2">
                {(
                  [
                    ["sizeSmall", 0.85],
                    ["sizeStandard", 1],
                    ["sizeLarge", 1.18],
                  ] as const
                ).map(([key, v]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => updateActiveStyle({ fontScale: v === 1 ? undefined : v })}
                    className={chip(Math.abs(fontScale - v) < 0.01)}
                  >
                    {t(key)}
                  </button>
                ))}
              </div>
            </section>

            {/* 字幕位置 */}
            <section>
              <h3 className="text-[12px] font-bold text-mut">{t("position")}</h3>
              <div className="mt-2 flex gap-2">
                {(
                  [
                    ["posLow", "low"],
                    ["posStandard", "standard"],
                    ["posHigh", "high"],
                  ] as const
                ).map(([key, v]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => updateActiveStyle({ captionPosition: v === "standard" ? undefined : v })}
                    className={chip(position === v)}
                  >
                    {t(key)}
                  </button>
                ))}
              </div>
            </section>

            {/* 水印 */}
            <section>
              <h3 className="text-[12px] font-bold text-mut">{t("watermark")}</h3>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void pickLogo()}
                  disabled={picking}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] font-semibold text-mut transition-colors hover:border-mut hover:text-fg disabled:opacity-50"
                >
                  <LuImage className="h-3.5 w-3.5" />
                  {wm?.path ? fileBase(wm.path) : t("pickLogo")}
                </button>
                {wm?.path && (
                  <button
                    type="button"
                    onClick={() => setWatermark(null)}
                    className="rounded-lg border border-line p-1.5 text-mut transition-colors hover:border-red-400 hover:text-red-400"
                    title={t("removeLogo")}
                  >
                    <LuTrash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              {wm?.path && (
                <div className="mt-2.5 space-y-2.5">
                  <div className="flex gap-2">
                    {(
                      [
                        ["cornerTl", "top-left"],
                        ["cornerTr", "top-right"],
                        ["cornerBl", "bottom-left"],
                        ["cornerBr", "bottom-right"],
                      ] as const
                    ).map(([key, v]) => (
                      <button key={key} type="button" onClick={() => setWatermark({ corner: v })} className={chip(wm.corner === v)}>
                        {t(key)}
                      </button>
                    ))}
                  </div>
                  <label className="flex items-center gap-2.5 text-[11.5px] text-mut">
                    {t("opacity")}
                    <input
                      type="range"
                      min={10}
                      max={100}
                      value={Math.round(wm.opacity * 100)}
                      onChange={(e) => setWatermark({ opacity: Number(e.target.value) / 100 })}
                      className="accent-[--color-ember]"
                    />
                    <span className="font-mono">{Math.round(wm.opacity * 100)}%</span>
                  </label>
                </div>
              )}
            </section>
          </div>

          {/* 右:9:16 迷你预览 */}
          <div className="w-36 shrink-0">
            <div className="relative aspect-9/16 overflow-hidden rounded-xl border border-line bg-gradient-to-b from-panel-2 to-black/70">
              {/* 标题贴片示意 */}
              <div className="absolute top-[9%] left-1/2 w-[86%] -translate-x-1/2 rounded-sm bg-black/55 px-1 py-0.5 text-center text-[7px] font-bold text-white">
                {t("previewTitle")}
              </div>
              {/* 字幕行:位置随档位,字号随缩放,高亮色实时生效 */}
              <div
                className="absolute left-1/2 w-[92%] -translate-x-1/2 -translate-y-1/2 text-center font-extrabold whitespace-nowrap"
                style={{ top: PREVIEW_BASELINE[position], fontSize: `${9 * fontScale}px` }}
              >
                <span className="text-white">{t("previewSaid")}</span>
                <span style={{ color: highlight }}>{t("previewHighlight")}</span>
              </div>
              {/* 水印示意 */}
              {wm?.path && (
                <div
                  className="absolute flex h-5 w-9 items-center justify-center rounded-xs border border-white/30 text-[6px] text-white/80"
                  style={{
                    opacity: wm.opacity,
                    ...(wm.corner.includes("top") ? { top: "4%" } : { bottom: "4%" }),
                    ...(wm.corner.includes("left") ? { left: "5%" } : { right: "5%" }),
                  }}
                >
                  LOGO
                </div>
              )}
            </div>
            <p className="mt-1.5 text-center text-[10.5px] text-mut/80">{t("previewNote")}</p>
          </div>
        </div>

        {/* 底部 */}
        <div className="mt-5 flex items-center justify-between gap-3 border-t border-dashed border-line pt-4">
          <p className="text-[11.5px] text-mut">{t("applyNote")}</p>
          <button
            type="button"
            onClick={onClose}
            className="btn-flame inline-flex items-center gap-1.5 rounded-lg px-5 py-2 text-[13px] font-bold text-white"
          >
            <LuCheck className="h-4 w-4" />
            {t("done")}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

export { activeBrandStyle };
