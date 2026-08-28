/**
 * 设置中心:左导航 + 分区内容,原先散落七处的配置合并到这里,任何时刻可达。
 *  - AI 模型:LLM 供应商/初筛/视觉(从爆点页的配置门整体搬来,不再"进不去爆点页就改不了")
 *  - 转写引擎:默认引擎 + 云端 Key(不再"转写完就锁死")
 *  - 导出与存储:模型位置/导出位置/画质/默认字幕(原 SettingsModal)
 *  - 品牌样式/热词词表/录播监听:入口
 *  - 语言
 */
import { useCallback, useEffect, useState } from "react";
import {
  LuArrowLeft,
  LuBookOpen,
  LuBot,
  LuCaptions,
  LuCircleCheck,
  LuChartNoAxesCombined,
  LuDatabase,
  LuDownload,
  LuExternalLink,
  LuFolderOpen,
  LuFolderSearch,
  LuFlaskConical,
  LuGauge,
  LuHardDrive,
  LuLanguages,
  LuLoaderCircle,
  LuMic,
  LuPalette,
  LuTrendingDown,
  LuTriangleAlert,
  LuTrash2,
  LuTrophy,
  LuUpload,
} from "react-icons/lu";
import { useT, useLocaleStore } from "../i18n/store";
import { LOCALE_LIST, REGISTRY } from "../i18n/messages";
import { getApi, isElectron } from "../api/provider";
import { useLlmStore, LLM_PRESET_LIST, LLM_PRESETS, presetForBaseUrl } from "../stores/llm-store";
import { useAsrStore } from "../stores/asr-store";
import { useRenderPrefs } from "../stores/render-prefs-store";
import { useSession } from "../stores/session-store";
import { preflightVerdict, type PreflightVerdict } from "../../../shared/llm-preflight";
import { Switch, SwitchRow } from "./ui";
import { GlossaryModal } from "./GlossaryModal";
import { BrandStyleModal } from "./BrandStyleModal";
import { WatchFolderModal } from "./WatchFolderModal";
import type { AsrEngineInfo, CaptionStyleChoice, DiagnosticsProgressEvent, DiagnosticsReport, ExportQuality, ModelsInfo, PerformanceEntry, PerformanceExperiment, PerformanceMatchSummary, PerformanceSummary } from "../../../shared/api-types";

type NavKey = "ai" | "asr" | "storage" | "diagnostics" | "performance" | "brand" | "glossary" | "watch" | "lang";

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

const ENGINE_TEXT: Record<string, { name: string; desc: string }> = {
  sensevoice: { name: "engineSensevoiceName", desc: "engineSensevoiceDesc" },
  paraformer: { name: "engineParaformerName", desc: "engineParaformerDesc" },
  fireredasr: { name: "engineFireredName", desc: "engineFireredDesc" },
  elevenlabs: { name: "engineElevenlabsName", desc: "engineElevenlabsDesc" },
};

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes > 0) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return "—";
}

function formatMetric(value: number, locale: string): string {
  return new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US", {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

function PerformanceRow({ entry, weak = false }: { entry: PerformanceEntry; weak?: boolean }): React.JSX.Element {
  const t = useT("performance");
  const { locale } = useLocaleStore();
  const interactions = entry.likes + entry.comments + entry.shares + entry.saves;
  const rate = ((interactions / Math.max(1, entry.views)) * 100).toFixed(2);
  return (
    <li className="rounded-xl border border-line/80 bg-panel-2 px-3.5 py-3">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[12.5px] font-semibold text-fg">{entry.title}</p>
          {entry.hook && <p className="mt-0.5 line-clamp-1 text-[11px] text-mut">{entry.hook}</p>}
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${weak ? "bg-amber-500/10 text-amber-300" : "bg-emerald-500/10 text-emerald-300"}`}>
          {entry.platform}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10.5px] tabular-nums text-mut">
        <span>{t("views", { n: formatMetric(entry.views, locale) })}</span>
        <span>{t("engagement", { n: rate })}</span>
        {entry.durationSec && <span>{t("duration", { n: Math.round(entry.durationSec) })}</span>}
      </div>
    </li>
  );
}

const EXPERIMENT_STATUS_KEY: Record<PerformanceExperiment["status"], string> = {
  "awaiting-metrics": "experimentStatusAwaiting",
  "incomplete-group": "experimentStatusIncomplete",
  "ambiguous-metrics": "experimentStatusAmbiguous",
  "platform-mismatch": "experimentStatusPlatform",
  "missing-publish-time": "experimentStatusTime",
  "outside-window": "experimentStatusWindow",
  "low-sample": "experimentStatusSample",
  inconclusive: "experimentStatusInconclusive",
  directional: "experimentStatusDirectional",
};

function ExperimentCard({ experiment }: { experiment: PerformanceExperiment }): React.JSX.Element {
  const t = useT("performance");
  const { locale } = useLocaleStore();
  const leader = experiment.variants.find((variant) => variant.contentId === experiment.leaderContentId);
  const ready = experiment.status === "directional" || experiment.status === "inconclusive";
  return (
    <article className="rounded-xl border border-line/80 bg-panel-2 p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11.5px] font-bold text-fg">
            {experiment.dimensions.includes("opening") ? t("experimentDimensionOpening") : t("experimentDimensionPackaging")}
          </p>
          <p className="mt-0.5 text-[10.5px] text-mut">{experiment.platform} · {t("experimentVariants", { n: experiment.variantTotal })}</p>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[9.5px] font-bold ${ready ? "bg-emerald-500/10 text-emerald-300" : "bg-amber-500/10 text-amber-300"}`}>
          {t(EXPERIMENT_STATUS_KEY[experiment.status])}
        </span>
      </div>
      <ul className="mt-2.5 space-y-1.5">
        {experiment.variants.map((variant) => {
          const isLeader = variant.contentId === experiment.leaderContentId;
          return (
            <li key={variant.contentId} className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 ${isLeader ? "border-emerald-500/40 bg-emerald-500/5" : "border-line/60 bg-panel"}`}>
              <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9.5px] font-black ${variant.role === "control" ? "bg-sky-500/10 text-sky-300" : "bg-ember/10 text-ember"}`}>
                {String.fromCharCode(64 + Math.min(26, variant.index))}
              </span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-fg/90">{variant.title}</span>
              {variant.views !== undefined && variant.weightedEngagementRate !== undefined ? (
                <span className="shrink-0 text-right font-mono text-[9.5px] leading-tight text-mut tabular-nums">
                  {formatMetric(variant.views, locale)} · {variant.weightedEngagementRate.toFixed(2)}%
                </span>
              ) : <span className="shrink-0 text-[9.5px] text-mut/60">{t("awaitingStatus")}</span>}
            </li>
          );
        })}
      </ul>
      {leader && experiment.relativeLiftPct !== undefined ? (
        <p className="mt-2 text-[10.5px] leading-relaxed text-emerald-300">
          {t("experimentDirectionalNote", { variant: String.fromCharCode(64 + Math.min(26, leader.index)), lift: experiment.relativeLiftPct })}
        </p>
      ) : (
        <p className="mt-2 text-[10.5px] leading-relaxed text-mut">{t("experimentEvidenceNote")}</p>
      )}
    </article>
  );
}

/** Local audience-outcome feedback: import → explain what was learned → manage memory. */
function PerformanceSection(): React.JSX.Element {
  const t = useT("performance");
  const [summary, setSummary] = useState<PerformanceSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [templating, setTemplating] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [correlation, setCorrelation] = useState<PerformanceMatchSummary | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError("");
    try {
      setSummary(await getApi().performanceGet());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const importFile = useCallback(async (): Promise<void> => {
    setImporting(true);
    setError("");
    setNotice("");
    setCorrelation(null);
    try {
      const result = await getApi().performanceImport();
      if (!result) return;
      setSummary(await getApi().performanceGet());
      setCorrelation(result.correlation);
      setNotice(t("importSuccess", {
        imported: result.imported,
        skipped: result.skipped,
        total: result.total,
        matched: result.correlation.matched,
        unmatched: result.correlation.unmatched + result.correlation.ambiguous,
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }, [t]);

  const exportTemplate = useCallback(async (): Promise<void> => {
    setTemplating(true);
    setError("");
    setNotice("");
    try {
      const result = await getApi().performanceTemplate();
      if (result) setNotice(t("templateSuccess", { count: result.count }));
      else if (summary?.publishing.awaitingMetrics === 0) setNotice(t("templateEmpty"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTemplating(false);
    }
  }, [summary, t]);

  const clear = useCallback(async (): Promise<void> => {
    if (!confirmClear) {
      setConfirmClear(true);
      setNotice("");
      return;
    }
    setClearing(true);
    setError("");
    try {
      await getApi().performanceClear();
      setSummary(await getApi().performanceGet());
      setNotice(t("clearSuccess"));
      setConfirmClear(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setClearing(false);
    }
  }, [confirmClear, t]);

  return (
    <div className="flex flex-col gap-5" aria-busy={loading || importing || templating || clearing}>
      <section>
        <h3 className="flex items-center gap-2 text-[13.5px] font-bold">
          <LuChartNoAxesCombined aria-hidden="true" className="h-4 w-4 text-ember" />
          {t("title")}
        </h3>
        <p className="mt-1 text-[12.5px] leading-relaxed text-mut">{t("desc")}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={importing || clearing}
            onClick={() => void importFile()}
            className="btn-flame inline-flex min-h-10 items-center gap-2 rounded-lg px-4 py-2 text-[12.5px] font-bold text-white disabled:opacity-50"
          >
            {importing ? <LuLoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" /> : <LuUpload aria-hidden="true" className="h-4 w-4" />}
            {importing ? t("importing") : t("importButton")}
          </button>
          <button
            type="button"
            disabled={importing || templating || clearing}
            onClick={() => void exportTemplate()}
            className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-line px-4 py-2 text-[12.5px] font-semibold text-fg transition-colors hover:border-ember/50 disabled:opacity-50"
          >
            {templating ? <LuLoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" /> : <LuDownload aria-hidden="true" className="h-4 w-4" />}
            {templating ? t("templating") : t("templateButton")}
          </button>
          <span className="text-[11px] text-mut/80">{t("formats")}</span>
        </div>
        {notice && (
          <p aria-live="polite" className="mt-3 flex items-start gap-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-[11.5px] text-emerald-300">
            <LuCircleCheck aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-3 flex items-start gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-[11.5px] break-all text-red-300">
            <LuTriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {error}
          </p>
        )}
        {correlation && (correlation.unmatched > 0 || correlation.ambiguous > 0) && (
          <div role="status" className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-[11.5px] text-amber-200">
            <p className="font-semibold">{t("matchReview")}</p>
            {correlation.unmatchedTitles.length > 0 && <p className="mt-1 break-words">{t("unmatchedRows", { titles: correlation.unmatchedTitles.join(" · ") })}</p>}
            {correlation.ambiguousTitles.length > 0 && <p className="mt-1 break-words">{t("ambiguousRows", { titles: correlation.ambiguousTitles.join(" · ") })}</p>}
          </div>
        )}
      </section>

      {!loading && summary && (
        <section className="rounded-xl border border-line bg-panel-2 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h4 className="text-[12.5px] font-bold text-fg">{t("ledgerTitle")}</h4>
              <p className="mt-1 text-[11px] leading-relaxed text-mut">{t("ledgerDesc")}</p>
            </div>
            <span className="shrink-0 rounded-full bg-ember/10 px-2.5 py-1 text-[10.5px] font-bold text-ember">{summary.publishing.total}</span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <div className="rounded-lg border border-line/70 bg-panel px-3 py-2.5">
              <p className="text-[10.5px] text-mut">{t("awaitingLabel")}</p>
              <p className="mt-0.5 text-lg font-black tabular-nums text-amber-300">{summary.publishing.awaitingMetrics}</p>
            </div>
            <div className="rounded-lg border border-line/70 bg-panel px-3 py-2.5">
              <p className="text-[10.5px] text-mut">{t("measuredLabel")}</p>
              <p className="mt-0.5 text-lg font-black tabular-nums text-emerald-300">{summary.publishing.measured}</p>
            </div>
          </div>
          {summary.publishing.recent.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {summary.publishing.recent.slice(0, 4).map((item) => (
                <li key={item.contentId} className="flex items-center justify-between gap-3 text-[11px]">
                  <span className="min-w-0 truncate text-fg/90">{item.title}</span>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${item.metricsImportedAt ? "bg-emerald-500/10 text-emerald-300" : "bg-amber-500/10 text-amber-300"}`}>
                    {item.metricsImportedAt ? t("measuredStatus") : t("awaitingStatus")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {!loading && summary && summary.experiments.total > 0 && (
        <section>
          <h4 className="flex items-center gap-2 text-[12.5px] font-bold text-fg">
            <LuFlaskConical aria-hidden="true" className="h-4 w-4 text-ember" />
            {t("experimentTitle")}
          </h4>
          <p className="mt-1 text-[11px] leading-relaxed text-mut">{t("experimentDesc")}</p>
          <div className="mt-2.5 grid grid-cols-4 gap-2">
            {[
              ["experimentTotal", summary.experiments.total, "text-fg"],
              ["experimentReady", summary.experiments.ready, "text-emerald-300"],
              ["experimentAwaiting", summary.experiments.awaiting, "text-amber-300"],
              ["experimentInsufficient", summary.experiments.insufficient, "text-mut"],
            ].map(([key, value, cls]) => (
              <div key={String(key)} className="rounded-lg border border-line/70 bg-panel px-2.5 py-2">
                <p className="text-[9.5px] text-mut">{t(String(key))}</p>
                <p className={`mt-0.5 text-base font-black tabular-nums ${cls}`}>{value}</p>
              </div>
            ))}
          </div>
          <div className="mt-3 space-y-2.5">
            {summary.experiments.recent.slice(0, 4).map((experiment) => <ExperimentCard key={experiment.experimentId} experiment={experiment} />)}
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-mut/70">{t("experimentCaution")}</p>
        </section>
      )}

      {loading ? (
        <div className="flex min-h-36 items-center justify-center rounded-xl border border-line bg-panel-2 text-[12px] text-mut">
          <LuLoaderCircle aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" />
          {t("loading")}
        </div>
      ) : !summary || summary.total === 0 ? (
        <div className="rounded-xl border border-dashed border-line px-5 py-8 text-center">
          <LuDatabase aria-hidden="true" className="mx-auto h-7 w-7 text-mut/50" />
          <p className="mt-3 text-[13px] font-semibold text-fg">{t("emptyTitle")}</p>
          <p className="mx-auto mt-1 max-w-md text-[11.5px] leading-relaxed text-mut">{t("emptyDesc")}</p>
        </div>
      ) : (
        <>
          <section className="grid grid-cols-3 gap-2">
            <div className="rounded-xl border border-line bg-panel-2 px-3.5 py-3">
              <p className="text-[10.5px] font-semibold text-mut">{t("totalLabel")}</p>
              <p className="mt-1 text-xl font-black tabular-nums text-fg">{summary.total}</p>
            </div>
            <div className="rounded-xl border border-line bg-panel-2 px-3.5 py-3">
              <p className="text-[10.5px] font-semibold text-mut">{t("platformLabel")}</p>
              <p className="mt-1 text-xl font-black tabular-nums text-fg">{summary.platforms.length}</p>
            </div>
            <div className="rounded-xl border border-line bg-panel-2 px-3.5 py-3">
              <p className="text-[10.5px] font-semibold text-mut">{t("signalLabel")}</p>
              <p className="mt-1 text-xl font-black tabular-nums text-fg">{summary.winners.length + summary.laggards.length}</p>
            </div>
          </section>

          <div className="flex flex-wrap gap-1.5">
            {summary.platforms.map((platform) => <span key={platform} className="chip rounded-full px-2.5 py-1 text-[10.5px] text-mut">{platform}</span>)}
          </div>

          <section>
            <h4 className="flex items-center gap-2 text-[12.5px] font-bold text-emerald-300">
              <LuTrophy aria-hidden="true" className="h-4 w-4" />
              {t("winnersTitle")}
            </h4>
            <p className="mt-1 text-[11px] leading-relaxed text-mut">{t("winnersDesc")}</p>
            <ul className="mt-2.5 space-y-2">{summary.winners.map((entry, i) => <PerformanceRow key={`${entry.platform}-${entry.id ?? entry.title}-${i}`} entry={entry} />)}</ul>
          </section>

          {summary.laggards.length > 0 && (
            <section>
              <h4 className="flex items-center gap-2 text-[12.5px] font-bold text-amber-300">
                <LuTrendingDown aria-hidden="true" className="h-4 w-4" />
                {t("laggardsTitle")}
              </h4>
              <p className="mt-1 text-[11px] leading-relaxed text-mut">{t("laggardsDesc")}</p>
              <ul className="mt-2.5 space-y-2">{summary.laggards.map((entry, i) => <PerformanceRow key={`${entry.platform}-${entry.id ?? entry.title}-${i}`} entry={entry} weak />)}</ul>
            </section>
          )}

          <section className="border-t border-line/70 pt-4">
            <button
              type="button"
              disabled={clearing}
              onClick={() => void clear()}
              onBlur={() => setConfirmClear(false)}
              className={`inline-flex min-h-10 items-center gap-2 rounded-lg border px-3.5 py-2 text-[12px] font-semibold transition-colors disabled:opacity-50 ${confirmClear ? "border-red-500/60 bg-red-500/10 text-red-300" : "border-line text-mut hover:border-red-500/40 hover:text-red-300"}`}
            >
              {clearing ? <LuLoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : <LuTrash2 aria-hidden="true" className="h-3.5 w-3.5" />}
              {confirmClear ? t("clearConfirm") : t("clearButton")}
            </button>
            <p className="mt-1.5 text-[10.5px] text-mut/70">{t("clearHint")}</p>
          </section>
        </>
      )}
    </div>
  );
}

const inputCls = "mt-1 w-full rounded-lg border border-line bg-panel-2 px-3 py-2 text-[13px] outline-none focus:border-ember/60";

/** AI 模型分区(LLM + 初筛 + 视觉,从旧配置门整体搬来)。 */
function AiSection(): React.JSX.Element {
  const t = useT("highlights");
  const { config, setConfig, prefilter, setPrefilter, vision, setVision } = useLlmStore();
  const { prefs, setPref } = useRenderPrefs();
  const [modelList, setModelList] = useState<string[]>([]);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState("");
  const [checking, setChecking] = useState(false);
  const [verdict, setVerdict] = useState<PreflightVerdict | null>(null);

  useEffect(() => {
    setVerdict(null);
  }, [config.baseUrl, config.apiKey, config.model]);

  const fetchModels = useCallback(async (): Promise<void> => {
    setModelLoading(true);
    setModelError("");
    const res = await getApi().listLlmModels(config.baseUrl, config.apiKey ?? "");
    setModelList(res.ids);
    setModelError(res.error ?? "");
    setModelLoading(false);
  }, [config.baseUrl, config.apiKey]);

  // 连接自检:必败配置(Ollama 没跑/Key 错/模型没拉)当场给指引(issue #6)
  const check = useCallback(async (): Promise<void> => {
    setChecking(true);
    const res = await getApi().listLlmModels(config.baseUrl, config.apiKey ?? "");
    setChecking(false);
    if (res.ids.length > 0) setModelList(res.ids);
    setVerdict(preflightVerdict(res, config.baseUrl, config.model));
  }, [config]);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="text-[12.5px] leading-relaxed text-mut">{t("llmDesc")}</p>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {LLM_PRESET_LIST.map((preset) => {
            const active = config.baseUrl === preset.baseUrl;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => {
                  setConfig({ baseUrl: preset.baseUrl, model: preset.model });
                  setModelList([]);
                  setModelError("");
                }}
                className={`rounded-xl border px-3 py-2.5 text-left text-[12.5px] font-semibold transition-colors ${
                  active ? "border-ember/60 bg-ember/10 text-fg" : "border-line text-mut hover:border-mut"
                }`}
              >
                {preset.label}
                <div className="mt-0.5 truncate text-[10.5px] font-normal text-mut">{preset.baseUrl.replace(/^https?:\/\//, "")}</div>
              </button>
            );
          })}
        </div>
        {presetForBaseUrl(config.baseUrl)?.id === "ollama" && (
          <p className="mt-2.5 rounded-lg bg-amber-500/10 px-3 py-2 text-[11.5px] leading-relaxed text-amber-400/90">{t("llmOllamaHint")}</p>
        )}
        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="text-[11px] font-semibold text-mut">{t("llmBaseUrl")}</span>
            <input value={config.baseUrl} onChange={(e) => setConfig({ baseUrl: e.target.value })} className={inputCls} />
          </label>
          <label className="block">
            <span className="text-[11px] font-semibold text-mut">{t("llmApiKey")}</span>
            <input
              type="password"
              value={config.apiKey}
              onChange={(e) => setConfig({ apiKey: e.target.value })}
              placeholder={t("llmKeyPlaceholder")}
              className={inputCls}
            />
          </label>
          <label className="block">
            <span className="text-[11px] font-semibold text-mut">{t("llmModel")}</span>
            <div className="mt-1 flex gap-2">
              <input
                value={config.model}
                list="hotclip-model-list"
                onChange={(e) => setConfig({ model: e.target.value })}
                className="min-w-0 flex-1 rounded-lg border border-line bg-panel-2 px-3 py-2 text-[13px] outline-none focus:border-ember/60"
              />
              <button
                type="button"
                disabled={!config.baseUrl || modelLoading}
                onClick={() => void fetchModels()}
                className="shrink-0 rounded-lg border border-line px-3 py-2 text-[12px] font-semibold text-mut transition-colors hover:border-mut hover:text-fg disabled:opacity-40"
              >
                {modelLoading ? t("llmModelsLoading") : t("llmModelsFetch")}
              </button>
            </div>
            <datalist id="hotclip-model-list">
              {modelList.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            {modelList.length > 0 && <span className="mt-1 block text-[10.5px] text-mut/80">{t("llmModelsFound", { n: modelList.length })}</span>}
            {modelError && <span className="mt-1 block text-[10.5px] text-amber-400/90">{modelError}</span>}
          </label>
        </div>
        {verdict && verdict.kind !== "ok" && verdict.kind !== "unknown" && (
          <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3.5 text-[12px] leading-relaxed text-amber-400">
            {verdict.kind === "local-down" && t("preflightLocalDown")}
            {verdict.kind === "unreachable" && t("preflightUnreachable")}
            {verdict.kind === "auth" && t("preflightAuth")}
            {verdict.kind === "model-missing" && (
              <>
                {t("preflightModelMissing", { model: config.model })}
                <span className="mt-1.5 flex flex-wrap gap-1.5">
                  {verdict.installed.slice(0, 8).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setConfig({ model: m })}
                      className="chip rounded-md px-2 py-0.5 font-mono text-[11px] text-fg/90 transition-colors hover:text-fg"
                    >
                      {m}
                    </button>
                  ))}
                </span>
              </>
            )}
          </div>
        )}
        {verdict && (verdict.kind === "ok" || verdict.kind === "unknown") && (
          <p className="mt-3 flex items-center gap-1.5 text-[12px] text-emerald-400">
            <LuCircleCheck className="h-4 w-4" />
            {t("llmModelsFound", { n: modelList.length })}
          </p>
        )}
        <div className="mt-4 flex items-center justify-between">
          <a
            href={presetForBaseUrl(config.baseUrl)?.keyUrl || LLM_PRESETS.atlas.keyUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[12px] text-ember hover:underline"
          >
            {t("llmGetKey")}
            <LuExternalLink className="h-3 w-3" />
          </a>
          <button
            type="button"
            disabled={checking || !config.baseUrl}
            onClick={() => void check()}
            className="rounded-lg border border-line px-4 py-2 text-[12.5px] font-semibold text-mut transition-colors hover:border-mut hover:text-fg disabled:opacity-40"
          >
            {checking ? t("preflightChecking") : t("llmModelsFetch")}
          </button>
        </div>
      </div>

      {/* 两级漏斗:本地小模型初筛 */}
      <div className="rounded-xl border border-dashed border-line p-3.5">
        <div className="flex items-center justify-between">
          <span className="text-[12.5px] font-bold">{t("prefilterTitle")}</span>
          <Switch on={prefilter.enabled} onToggle={() => setPrefilter({ enabled: !prefilter.enabled })} />
        </div>
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-mut">{t("prefilterDesc")}</p>
        {prefilter.enabled && (
          <div className="mt-2.5 grid grid-cols-2 gap-2.5">
            <label className="block">
              <span className="text-[11px] font-semibold text-mut">{t("llmBaseUrl")}</span>
              <input value={prefilter.baseUrl} onChange={(e) => setPrefilter({ baseUrl: e.target.value })} className={inputCls} />
            </label>
            <label className="block">
              <span className="text-[11px] font-semibold text-mut">{t("llmModel")}</span>
              <input value={prefilter.model} onChange={(e) => setPrefilter({ model: e.target.value })} className={inputCls} />
            </label>
          </div>
        )}
      </div>

      {/* 视觉信号 + 全场扫描 */}
      <div className="rounded-xl border border-dashed border-line p-3.5">
        <div className="flex items-center justify-between">
          <span className="text-[12.5px] font-bold">{t("visionTitle")}</span>
          <Switch on={vision.enabled} onToggle={() => setVision({ enabled: !vision.enabled })} />
        </div>
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-mut">{t("visionDesc")}</p>
        {vision.enabled && (
          <div className="mt-2.5 grid grid-cols-2 gap-2.5">
            <label className="block">
              <span className="text-[11px] font-semibold text-mut">{t("llmBaseUrl")}</span>
              <input value={vision.baseUrl} onChange={(e) => setVision({ baseUrl: e.target.value })} className={inputCls} />
            </label>
            <label className="block">
              <span className="text-[11px] font-semibold text-mut">{t("llmModel")}</span>
              <input value={vision.model} onChange={(e) => setVision({ model: e.target.value })} className={inputCls} />
            </label>
            <label className="col-span-2 block">
              <span className="text-[11px] font-semibold text-mut">{t("visionApiKey")}</span>
              <input
                type="password"
                value={vision.apiKey ?? ""}
                onChange={(e) => setVision({ apiKey: e.target.value })}
                placeholder={t("visionApiKeyPlaceholder")}
                className={inputCls}
              />
            </label>
            <div className="col-span-2">
              <SwitchRow label={t("scanTitle")} hint={t("scanDesc")} on={prefs.fullScan} onToggle={() => setPref({ fullScan: !prefs.fullScan })} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** 转写引擎分区:默认引擎 + 云端 Key。 */
function AsrSection(): React.JSX.Element {
  const t = useT("transcribe");
  const tw = useT("workbench");
  const { engineId, setEngineId, keys, setKey } = useAsrStore();
  const [engines, setEngines] = useState<AsrEngineInfo[] | null>(null);
  useEffect(() => {
    getApi()
      .listAsrEngines()
      .then(setEngines)
      .catch(() => setEngines([]));
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12.5px] leading-relaxed text-mut">{tw("asrDesc")}</p>
      {(engines ?? []).map((e) => {
        const text = ENGINE_TEXT[e.id];
        const active = engineId === e.id;
        return (
          <button
            key={e.id}
            type="button"
            onClick={() => setEngineId(e.id)}
            className={`rounded-xl border p-4 text-left transition-colors ${active ? "border-ember/60 bg-ember/5" : "border-line hover:border-mut"}`}
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-[13.5px] font-bold">{text ? t(text.name) : e.id}</span>
              <span className={`flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full border ${active ? "flame-gradient border-transparent" : "border-line"}`}>
                {active && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
              </span>
            </div>
            {text && <p className="mt-1 text-[12px] text-mut">{t(text.desc)}</p>}
            {active && e.kind === "cloud" && (
              <input
                type="password"
                value={keys[e.id] ?? ""}
                onChange={(ev) => setKey(e.id, ev.target.value)}
                onClick={(ev) => ev.stopPropagation()}
                placeholder={t("cloudKeyPlaceholder")}
                className="mt-2.5 w-full rounded-lg border border-line bg-panel-2 px-3 py-2 text-[12px] outline-none focus:border-ember/60"
              />
            )}
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[10.5px]">
              <span className="chip rounded-md px-2 py-0.5">{e.uploads ? t("badgeNeedsUpload") : t("badgeLocalPrivate")}</span>
              <span className="chip rounded-md px-2 py-0.5">{t("badgeLangs", { langs: e.langs.join("/") })}</span>
              {e.kind === "local" && (
                <span className={`chip rounded-md px-2 py-0.5 ${e.installed ? "text-emerald-400" : ""}`}>
                  {e.installed ? t("badgeInstalled") : t("badgeDownload", { n: e.sizeMB ?? 0 })}
                </span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

/** 导出与存储分区(原 SettingsModal 的四节)。 */
function StorageSection(): React.JSX.Element {
  const t = useT("settings");
  const { prefs, setPref } = useRenderPrefs();
  const { outDir, quality, captionStyle } = prefs;
  const [defaultOutDir, setDefaultOutDir] = useState("");
  const [models, setModels] = useState<ModelsInfo | null>(null);
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

  const moveTo = async (dir: string): Promise<void> => {
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

  const installedCount = models?.entries.filter((e) => e.installed).length ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="flex items-center gap-2 text-[13.5px] font-bold">
          <LuHardDrive className="h-4 w-4 text-ember" />
          {t("modelsTitle")}
        </h3>
        <p className="mt-1 text-[11.5px] leading-relaxed text-mut">{t("modelsDesc")}</p>
        <div className="mt-3 rounded-xl bg-panel-2 px-3.5 py-3">
          <p className="font-mono text-[11.5px] break-all text-fg">{models?.root ?? "…"}</p>
          <p className="mt-1.5 text-[11.5px] text-mut">
            {models ? t("modelsSummary", { n: installedCount, total: models.entries.length, size: formatBytes(models.totalBytes) }) : t("modelsLoading")}
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
                onClick={() =>
                  void getApi()
                    .selectDir()
                    .then((d) => {
                      if (d) void moveTo(d);
                    })
                }
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] font-semibold whitespace-nowrap text-mut transition-colors hover:border-mut hover:text-fg disabled:opacity-40"
              >
                {moving ? <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <LuHardDrive className="h-3.5 w-3.5" />}
                {moving ? t("moving") : t("moveModels")}
              </button>
              {models && models.root !== models.defaultRoot && (
                <button
                  type="button"
                  disabled={moving}
                  onClick={() => models && void moveTo(models.defaultRoot)}
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
              {m.installed ? <LuCircleCheck className="h-3.5 w-3.5 shrink-0 text-emerald-400" /> : <LuDownload className="h-3.5 w-3.5 shrink-0 text-mut/60" />}
              <span className={`shrink-0 ${m.installed ? "text-fg" : "text-mut"}`}>{t(m.useKey)}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-mut/70">{m.id}</span>
              <span className={`shrink-0 tabular-nums ${m.installed ? "text-mut" : "text-mut/50"}`}>
                {m.installed ? formatBytes(m.bytes) : t("notInstalled", { size: formatBytes(m.approxBytes) })}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3 className="flex items-center gap-2 text-[13.5px] font-bold">
          <LuFolderOpen className="h-4 w-4 text-ember" />
          {t("outDirTitle")}
        </h3>
        <p className="mt-1 text-[11.5px] leading-relaxed text-mut">{t("outDirDesc")}</p>
        <div className="mt-3 rounded-xl bg-panel-2 px-3.5 py-3">
          <p className="font-mono text-[11.5px] break-all text-fg">{outDir || defaultOutDir || "…"}</p>
          {isElectron() && (
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void getApi().selectDir().then((d) => d && setPref({ outDir: d }))}
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
      </section>

      <section>
        <h3 className="flex items-center gap-2 text-[13.5px] font-bold">
          <LuGauge className="h-4 w-4 text-ember" />
          {t("qualityTitle")}
        </h3>
        <p className="mt-1 text-[11.5px] leading-relaxed text-mut">{t("qualityDesc")}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {QUALITY_ORDER.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => setPref({ quality: q })}
              className={`min-w-0 flex-1 rounded-xl border px-3.5 py-2.5 text-left transition-colors ${
                quality === q ? "border-ember/60 bg-ember/10" : "border-line hover:border-mut"
              }`}
            >
              <span className={`block text-[12.5px] font-bold ${quality === q ? "text-fg" : "text-mut"}`}>{t(`quality_${q}`)}</span>
              <span className="mt-0.5 block text-[11px] leading-snug text-mut/80">{t(`quality_${q}_hint`)}</span>
            </button>
          ))}
        </div>
      </section>

      <section>
        <h3 className="flex items-center gap-2 text-[13.5px] font-bold">
          <LuCaptions className="h-4 w-4 text-ember" />
          {t("captionTitle")}
        </h3>
        <p className="mt-1 text-[11.5px] leading-relaxed text-mut">{t("captionDesc")}</p>
        <div className="mt-3 flex flex-wrap gap-2">
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
      </section>
    </div>
  );
}

function DiagnosticsSection(): React.JSX.Element {
  const t = useT("diagnostics");
  const { locale } = useLocaleStore();
  const { config } = useLlmStore();
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [running, setRunning] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [clearingCache, setClearingCache] = useState(false);
  const [confirmClearCache, setConfirmClearCache] = useState(false);
  const [clearingEvidence, setClearingEvidence] = useState(false);
  const [confirmClearEvidence, setConfirmClearEvidence] = useState(false);
  const [progress, setProgress] = useState<DiagnosticsProgressEvent | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => getApi().onDiagnosticsProgress(setProgress), []);

  const run = useCallback(async (): Promise<void> => {
    setRunning(true);
    setError("");
    setNotice("");
    setConfirmClearCache(false);
    setConfirmClearEvidence(false);
    try {
      setReport(await getApi().diagnosticsRun(config.baseUrl && config.model ? config : null, locale));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }, [config, locale]);

  const clearCache = useCallback(async (): Promise<void> => {
    if (!confirmClearCache) {
      setConfirmClearCache(true);
      setConfirmClearEvidence(false);
      setNotice("");
      return;
    }
    setClearingCache(true);
    setError("");
    setNotice("");
    try {
      setReport(await getApi().diagnosticsClearRenderCache(config.baseUrl && config.model ? config : null, locale));
      setNotice(t("clearCacheSuccess"));
      setConfirmClearCache(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setClearingCache(false);
    }
  }, [config, confirmClearCache, locale, t]);

  const clearEvidence = useCallback(async (): Promise<void> => {
    if (!confirmClearEvidence) {
      setConfirmClearEvidence(true);
      setConfirmClearCache(false);
      setNotice("");
      return;
    }
    setClearingEvidence(true);
    setError("");
    setNotice("");
    try {
      setReport(await getApi().diagnosticsClearEvidenceIndex(config.baseUrl && config.model ? config : null, locale));
      setNotice(t("clearEvidenceSuccess"));
      setConfirmClearEvidence(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setClearingEvidence(false);
    }
  }, [config, confirmClearEvidence, locale, t]);

  const repair = useCallback(async (): Promise<void> => {
    setRepairing(true);
    setProgress(null);
    setError("");
    setNotice("");
    setConfirmClearCache(false);
    setConfirmClearEvidence(false);
    try {
      setReport(await getApi().diagnosticsPrepareModels(config.baseUrl && config.model ? config : null, locale));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!/abort/i.test(message)) setError(message);
    } finally {
      setRepairing(false);
      setProgress(null);
    }
  }, [config, locale]);

  const failures = report?.checks.filter((check) => check.status === "fail").length ?? 0;
  const warnings = report?.checks.filter((check) => check.status === "warn").length ?? 0;
  const hasRenderCache = report?.checks.some((check) => check.id === "render-cache") ?? false;
  const hasEvidenceIndex = report?.checks.some((check) => check.id === "evidence-index") ?? false;
  const busy = running || repairing || clearingCache || clearingEvidence;

  return (
    <div className="flex flex-col gap-5" aria-busy={busy}>
      <section>
        <h3 className="flex items-center gap-2 text-[13.5px] font-bold">
          <LuGauge aria-hidden="true" className="h-4 w-4 text-ember" />
          {t("title")}
        </h3>
        <p className="mt-1 text-[12px] leading-relaxed text-mut">{t("desc")}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => void run()} className="btn-flame inline-flex min-h-10 items-center gap-2 rounded-lg px-4 py-2 text-[12.5px] font-bold text-white disabled:opacity-50">
            {running ? <LuLoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" /> : <LuGauge aria-hidden="true" className="h-4 w-4" />}
            {running ? t("running") : t("run")}
          </button>
          {report && report.missingCoreModels > 0 && (
            <button type="button" disabled={busy} onClick={() => void repair()} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-line px-4 py-2 text-[12.5px] font-semibold text-fg hover:border-ember/50 disabled:opacity-50">
              {repairing ? <LuLoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" /> : <LuDownload aria-hidden="true" className="h-4 w-4" />}
              {repairing ? t("preparing") : t("prepare", { n: report.missingCoreModels })}
            </button>
          )}
          {hasRenderCache && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void clearCache()}
              className={`inline-flex min-h-10 items-center gap-2 rounded-lg border px-3.5 py-2 text-[12px] font-semibold transition-colors disabled:opacity-50 ${confirmClearCache ? "border-red-500/60 bg-red-500/10 text-red-300" : "border-line text-mut hover:border-red-500/40 hover:text-red-300"}`}
            >
              {clearingCache ? <LuLoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" /> : <LuTrash2 aria-hidden="true" className="h-4 w-4" />}
              {clearingCache ? t("clearingCache") : confirmClearCache ? t("clearCacheConfirm") : t("clearCache")}
            </button>
          )}
          {hasEvidenceIndex && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void clearEvidence()}
              className={`inline-flex min-h-10 items-center gap-2 rounded-lg border px-3.5 py-2 text-[12px] font-semibold transition-colors disabled:opacity-50 ${confirmClearEvidence ? "border-red-500/60 bg-red-500/10 text-red-300" : "border-line text-mut hover:border-red-500/40 hover:text-red-300"}`}
            >
              {clearingEvidence ? <LuLoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" /> : <LuTrash2 aria-hidden="true" className="h-4 w-4" />}
              {clearingEvidence ? t("clearingEvidence") : confirmClearEvidence ? t("clearEvidenceConfirm") : t("clearEvidence")}
            </button>
          )}
          {repairing && (
            <button type="button" onClick={() => getApi().diagnosticsCancelRepair()} className="min-h-10 rounded-lg border border-line px-3 py-2 text-[12px] font-semibold text-mut hover:text-fg">
              {t("cancel")}
            </button>
          )}
        </div>
        {progress && repairing && (
          <div className="mt-3" aria-live="polite">
            <div className="flex justify-between text-[10.5px] text-mut">
              <span>{t(progress.phase === "extract" ? "extracting" : "downloading", { current: progress.current, total: progress.total })}</span>
              <span>{Math.round(progress.fraction * 100)}%</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/8"><div className="h-full rounded-full bg-ember transition-[width]" style={{ width: `${progress.fraction * 100}%` }} /></div>
            <p className="mt-1 font-mono text-[10px] text-mut/70">{progress.modelId}</p>
          </div>
        )}
        {error && <p role="alert" className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-[11.5px] break-all text-red-300">{error}</p>}
        {notice && <p role="status" aria-live="polite" className="mt-3 rounded-lg bg-emerald-500/10 px-3 py-2 text-[11.5px] text-emerald-300">{notice}</p>}
      </section>

      {!report ? (
        <div className="rounded-xl border border-dashed border-line px-5 py-8 text-center text-[12px] text-mut">{t("empty")}</div>
      ) : (
        <section>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px]">
            <span className="rounded-full bg-emerald-500/10 px-2.5 py-1 text-emerald-300">{t("okCount", { n: report.checks.length - failures - warnings })}</span>
            {warnings > 0 && <span className="rounded-full bg-amber-500/10 px-2.5 py-1 text-amber-300">{t("warnCount", { n: warnings })}</span>}
            {failures > 0 && <span className="rounded-full bg-red-500/10 px-2.5 py-1 text-red-300">{t("failCount", { n: failures })}</span>}
          </div>
          <ul className="space-y-2">
            {report.checks.map((check) => (
              <li key={check.id} className="rounded-xl border border-line bg-panel-2 px-3.5 py-3">
                <div className="flex items-start gap-2.5">
                  {check.status === "ok" ? <LuCircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" /> : <LuTriangleAlert className={`mt-0.5 h-4 w-4 shrink-0 ${check.status === "fail" ? "text-red-400" : "text-amber-400"}`} />}
                  <div className="min-w-0 flex-1">
                    <p className="text-[12px] font-semibold text-fg">{check.name}</p>
                    <p className="mt-0.5 text-[10.5px] break-words text-mut">{check.detail}</p>
                    {check.fix && <p className="mt-1.5 rounded-md bg-white/4 px-2 py-1.5 text-[10.5px] leading-relaxed text-fg/80">{t("fixPrefix")}{check.fix}</p>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[10.5px] text-mut/70">{t("privacy")}</p>
        </section>
      )}
    </div>
  );
}

export function SettingsView(): React.JSX.Element {
  const t = useT("workbench");
  const tb = useT("brand");
  const tg = useT("glossary");
  const twatch = useT("watch");
  const { locale, setLocale } = useLocaleStore();
  const { setSettingsOpen } = useSession();
  const [nav, setNav] = useState<NavKey>("ai");
  const [showBrand, setShowBrand] = useState(false);
  const [showGlossary, setShowGlossary] = useState(false);
  const [showWatch, setShowWatch] = useState(false);

  const NAV: Array<{ key: NavKey; label: string; Icon: typeof LuBot }> = [
    { key: "ai", label: t("navAi"), Icon: LuBot },
    { key: "asr", label: t("navAsr"), Icon: LuMic },
    { key: "storage", label: t("navStorage"), Icon: LuHardDrive },
    { key: "diagnostics", label: t("navDiagnostics"), Icon: LuGauge },
    { key: "performance", label: t("navPerformance"), Icon: LuChartNoAxesCombined },
    { key: "brand", label: t("navBrand"), Icon: LuPalette },
    { key: "glossary", label: t("navGlossary"), Icon: LuBookOpen },
    { key: "watch", label: t("navWatch"), Icon: LuFolderSearch },
    { key: "lang", label: t("navLang"), Icon: LuLanguages },
  ];

  /** 入口型分区:说明 + 打开按钮(品牌/词表/录播共用形态)。 */
  const entry = (desc: string, label: string, open: () => void): React.JSX.Element => (
    <div className="flex flex-col gap-3">
      <p className="text-[12.5px] leading-relaxed text-mut">{desc}</p>
      <button type="button" onClick={open} className="btn-flame self-start rounded-lg px-5 py-2 text-[12.5px] font-bold text-white">
        {label}
      </button>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[200px] shrink-0 flex-col gap-1 border-r border-line/70 bg-panel/40 p-3">
        <button
          type="button"
          onClick={() => setSettingsOpen(false)}
          className="mb-2 flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-[12px] font-semibold text-mut transition-colors hover:text-fg"
        >
          <LuArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
          {t("backHome")}
        </button>
        {NAV.map(({ key, label, Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setNav(key)}
            className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12.5px] font-semibold transition-colors ${
              nav === key ? "border border-ember/40 bg-ember/10 text-ember" : "border border-transparent text-mut hover:text-fg"
            }`}
          >
            <Icon aria-hidden="true" className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-2xl">
          {nav === "ai" && <AiSection />}
          {nav === "asr" && <AsrSection />}
          {nav === "storage" && <StorageSection />}
          {nav === "diagnostics" && <DiagnosticsSection />}
          {nav === "performance" && <PerformanceSection />}
          {nav === "brand" && entry(tb("desc"), tb("title"), () => setShowBrand(true))}
          {nav === "glossary" && entry(tg("desc"), tg("title"), () => setShowGlossary(true))}
          {nav === "watch" && entry(twatch("desc"), twatch("title"), () => setShowWatch(true))}
          {nav === "lang" && (
            <div className="flex flex-col gap-3">
              <p className="text-[12.5px] leading-relaxed text-mut">{t("langDesc")}</p>
              <div className="flex gap-2">
                {LOCALE_LIST.map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => setLocale(l)}
                    className={`rounded-lg border px-4 py-2 text-[12.5px] font-semibold transition-colors ${
                      locale === l ? "border-ember/60 bg-ember/10 text-fg" : "border-line text-mut hover:border-mut"
                    }`}
                  >
                    {REGISTRY[l].label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      {showBrand && <BrandStyleModal onClose={() => setShowBrand(false)} />}
      {showGlossary && <GlossaryModal onClose={() => setShowGlossary(false)} />}
      {showWatch && <WatchFolderModal onClose={() => setShowWatch(false)} />}
    </div>
  );
}
