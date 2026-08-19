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
  LuDownload,
  LuExternalLink,
  LuFolderOpen,
  LuFolderSearch,
  LuGauge,
  LuHardDrive,
  LuLanguages,
  LuLoaderCircle,
  LuMic,
  LuPalette,
  LuTriangleAlert,
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
import type { AsrEngineInfo, CaptionStyleChoice, ExportQuality, ModelsInfo } from "../../../shared/api-types";

type NavKey = "ai" | "asr" | "storage" | "brand" | "glossary" | "watch" | "lang";

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
          <LuArrowLeft className="h-3.5 w-3.5" />
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
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-2xl">
          {nav === "ai" && <AiSection />}
          {nav === "asr" && <AsrSection />}
          {nav === "storage" && <StorageSection />}
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
