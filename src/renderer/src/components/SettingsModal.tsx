/**
 * 设置(issue #3):把「藏在代码里、用户找不到」的几件事摆到台面上——
 * 模型存在哪儿、占多大、能不能挪走;成片导出到哪儿;导出画质与默认字幕样式。
 * 报告人原话:「模型存放位置我确实也找过,但没有找到,因为他文件比较大」。
 */
import { useCallback, useEffect, useState } from "react";
import {
  LuSettings,
  LuX,
  LuFolderOpen,
  LuHardDrive,
  LuCircleCheck,
  LuDownload,
  LuGauge,
  LuCaptions,
  LuLoaderCircle,
  LuTriangleAlert,
} from "react-icons/lu";
import { useT } from "../i18n/store";
import { getApi, isElectron } from "../api/provider";
import { useRenderPrefs } from "../stores/render-prefs-store";
import type { CaptionStyleChoice, ExportQuality, ModelsInfo } from "../../../shared/api-types";

const QUALITY_ORDER: ExportQuality[] = ["high", "standard", "compact"];
const CAPTION_ORDER: CaptionStyleChoice[] = ["keyword", "pop", "minimal", "hormozi", "bubble", "karaoke", "none"];
const CAPTION_KEY: Record<CaptionStyleChoice, string> = {
  none: "captionNone",
  karaoke: "captionKaraoke",
  keyword: "captionKeyword",
  pop: "captionPop",
  hormozi: "captionHormozi",
  minimal: "captionMinimal",
  bubble: "captionBubble",
};

/** 体积按人看得懂的量级显示——模型动辄 1GB,统一 MB 会刷屏。 */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes > 0) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return "—";
}

/** 小节外壳:统一标题+图标+分隔,免得每节各写一遍。 */
function Section({
  Icon,
  title,
  desc,
  children,
}: {
  Icon: typeof LuGauge;
  title: string;
  desc?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="border-t border-dashed border-line pt-4 first:border-0 first:pt-0">
      <h3 className="flex items-center gap-2 text-[14px] font-bold">
        <Icon className="h-4 w-4 text-ember" />
        {title}
      </h3>
      {desc && <p className="mt-1 text-[12px] leading-relaxed text-mut">{desc}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function SettingsModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const t = useT("settings");
  const { prefs, setPref } = useRenderPrefs();
  const { outDir, quality, captionStyle } = prefs;
  const [defaultOutDir, setDefaultOutDir] = useState("");
  const [models, setModels] = useState<ModelsInfo | null>(null);
  /** 搬家进行中:1GB 跨盘复制要几十秒,期间禁掉按钮并说明「别关窗口」。 */
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);

  const loadModels = useCallback(async (): Promise<void> => {
    const info = await getApi().modelsInfo().catch(() => null);
    if (info) setModels(info);
  }, []);

  useEffect(() => {
    void getApi().defaultOutDir().then(setDefaultOutDir).catch(() => {});
    void loadModels();
  }, [loadModels]);

  const pickOutDir = async (): Promise<void> => {
    const dir = await getApi().selectDir();
    if (dir) setPref({ outDir: dir });
  };

  const pickModelsDir = async (): Promise<void> => {
    const dir = await getApi().selectDir();
    if (!dir) return;
    setMoveError(null);
    setMoving(true);
    try {
      await getApi().moveModelsDir(dir);
      await loadModels();
    } catch (e) {
      // 搬家失败必须说清楚——用户最怕的是「模型是不是被弄丢了」
      setMoveError(e instanceof Error ? e.message : String(e));
    } finally {
      setMoving(false);
    }
  };

  const resetModelsDir = async (): Promise<void> => {
    if (!models || models.root === models.defaultRoot) return;
    setMoveError(null);
    setMoving(true);
    try {
      await getApi().moveModelsDir(models.defaultRoot);
      await loadModels();
    } catch (e) {
      setMoveError(e instanceof Error ? e.message : String(e));
    } finally {
      setMoving(false);
    }
  };

  const installedCount = models?.entries.filter((e) => e.installed).length ?? 0;

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
    >
      <section
        className="card flex max-h-[86vh] w-full max-w-2xl flex-col rounded-2xl p-6"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t("title")}
      >
        <div className="flex shrink-0 items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-extrabold">
            <LuSettings className="h-5 w-5 text-ember" />
            {t("title")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-mut transition-colors hover:text-fg"
            aria-label="close"
          >
            <LuX className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-5 flex flex-col gap-5 overflow-y-auto pr-1">
          {/* ---- 模型存放位置 ---- */}
          <Section Icon={LuHardDrive} title={t("modelsTitle")} desc={t("modelsDesc")}>
            <div className="rounded-xl bg-panel-2 px-3.5 py-3">
              <p className="font-mono text-[11.5px] break-all text-fg">{models?.root ?? "…"}</p>
              <p className="mt-1.5 text-[11.5px] text-mut">
                {models
                  ? t("modelsSummary", {
                      n: installedCount,
                      total: models.entries.length,
                      size: formatBytes(models.totalBytes),
                    })
                  : t("modelsLoading")}
              </p>
              {isElectron() && (
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={!models}
                    onClick={() => models && getApi().openFolder(models.root)}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] font-semibold whitespace-nowrap text-mut transition-colors hover:border-mut hover:text-fg disabled:opacity-40"
                  >
                    <LuFolderOpen className="h-3.5 w-3.5" />
                    {t("openFolder")}
                  </button>
                  <button
                    type="button"
                    disabled={moving}
                    onClick={() => void pickModelsDir()}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] font-semibold whitespace-nowrap text-mut transition-colors hover:border-mut hover:text-fg disabled:opacity-40"
                  >
                    {moving ? <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <LuHardDrive className="h-3.5 w-3.5" />}
                    {moving ? t("moving") : t("moveModels")}
                  </button>
                  {models && models.root !== models.defaultRoot && (
                    <button
                      type="button"
                      disabled={moving}
                      onClick={() => void resetModelsDir()}
                      className="shrink-0 text-[12px] text-mut underline-offset-2 transition-colors hover:text-fg hover:underline disabled:opacity-40"
                    >
                      {t("useDefault")}
                    </button>
                  )}
                </div>
              )}
              {moving && <p className="mt-2 text-[11.5px] text-amber-300/90">{t("movingHint")}</p>}
              {moveError && (
                <p className="mt-2 flex items-start gap-1.5 text-[11.5px] break-all text-red-400">
                  <LuTriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {moveError}
                </p>
              )}
            </div>

            <ul className="mt-2.5 space-y-1">
              {models?.entries.map((m) => (
                <li key={m.id} className="flex items-center gap-2 text-[11.5px]">
                  {m.installed ? (
                    <LuCircleCheck className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                  ) : (
                    <LuDownload className="h-3.5 w-3.5 shrink-0 text-mut/60" />
                  )}
                  <span className={`shrink-0 ${m.installed ? "text-fg" : "text-mut"}`}>{t(m.useKey)}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-mut/70">{m.id}</span>
                  <span className={`shrink-0 tabular-nums ${m.installed ? "text-mut" : "text-mut/50"}`}>
                    {m.installed ? formatBytes(m.bytes) : t("notInstalled", { size: formatBytes(m.approxBytes) })}
                  </span>
                </li>
              ))}
            </ul>
          </Section>

          {/* ---- 导出位置 ---- */}
          <Section Icon={LuFolderOpen} title={t("outDirTitle")} desc={t("outDirDesc")}>
            <div className="rounded-xl bg-panel-2 px-3.5 py-3">
              <p className="font-mono text-[11.5px] break-all text-fg">{outDir || defaultOutDir || "…"}</p>
              {isElectron() && (
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void pickOutDir()}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] font-semibold whitespace-nowrap text-mut transition-colors hover:border-mut hover:text-fg"
                  >
                    <LuFolderOpen className="h-3.5 w-3.5" />
                    {t("change")}
                  </button>
                  <button
                    type="button"
                    onClick={() => getApi().openFolder(outDir || defaultOutDir)}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] font-semibold whitespace-nowrap text-mut transition-colors hover:border-mut hover:text-fg"
                  >
                    {t("openFolder")}
                  </button>
                  {outDir && (
                    <button
                      type="button"
                      onClick={() => setPref({ outDir: "" })}
                      className="shrink-0 text-[12px] text-mut underline-offset-2 transition-colors hover:text-fg hover:underline"
                    >
                      {t("useDefault")}
                    </button>
                  )}
                </div>
              )}
            </div>
          </Section>

          {/* ---- 导出画质 ---- */}
          <Section Icon={LuGauge} title={t("qualityTitle")} desc={t("qualityDesc")}>
            <div className="flex flex-wrap gap-2">
              {QUALITY_ORDER.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => setPref({ quality: q })}
                  className={`min-w-0 flex-1 rounded-xl border px-3.5 py-2.5 text-left transition-colors ${
                    quality === q ? "border-ember/60 bg-ember/10" : "border-line hover:border-mut"
                  }`}
                >
                  <span className={`block text-[12.5px] font-bold ${quality === q ? "text-fg" : "text-mut"}`}>
                    {t(`quality_${q}`)}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-mut/80">{t(`quality_${q}_hint`)}</span>
                </button>
              ))}
            </div>
          </Section>

          {/* ---- 默认字幕样式 ---- */}
          <Section Icon={LuCaptions} title={t("captionTitle")} desc={t("captionDesc")}>
            <div className="flex flex-wrap gap-2">
              {CAPTION_ORDER.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setPref({ captionStyle: c })}
                  className={`inline-flex shrink-0 items-center rounded-full border px-3 py-1.5 text-[12px] font-semibold whitespace-nowrap transition-colors ${
                    captionStyle === c ? "border-ember/60 bg-ember/10 text-fg" : "border-line text-mut hover:border-mut"
                  }`}
                >
                  {t(CAPTION_KEY[c])}
                </button>
              ))}
            </div>
          </Section>
        </div>
      </section>
    </div>
  );
}
