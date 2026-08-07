/**
 * Highlight detection view: LLM settings gate → detecting state → candidate
 * cards with the evidence chain (score / hook / reason / boundary quality).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  LuFlame,
  LuQuote,
  LuSparkles,
  LuArrowLeft,
  LuClock3,
  LuShoppingCart,
  LuCrosshair,
  LuKeyRound,
  LuExternalLink,
  LuCheck,
  LuScissors,
  LuScissorsLineDashed,
  LuSmartphone,
  LuMonitor,
  LuCaptions,
  LuFastForward,
  LuEraser,
  LuRepeat2,
  LuScan,
  LuUsers,
  LuTriangleAlert,
  LuType,
  LuZap,
  LuVolume2,
  LuAudioWaveform,
  LuListVideo,
  LuChevronLeft,
  LuChevronRight,
  LuPlay,
  LuPalette,
  LuLanguages,
  LuMegaphone,
  LuFileText,
  LuPencil,
  LuFilm,
  LuBadgeCheck,
  LuTarget,
  LuFolderOpen,
  LuPackage,
  LuLayers,
  LuBell,
  LuMusic,
  LuTextSelect,
} from "react-icons/lu";
import { useT, useLocaleStore } from "../i18n/store";
import { GENRE_PRESETS, GENRE_CUSTOM_MAX_CHARS } from "../../../core/genre";
import { getApi, isElectron } from "../api/provider";
import { useLlmStore, isLlmReady, LLM_PRESETS, LLM_PRESET_LIST, presetForBaseUrl } from "../stores/llm-store";
import { useBrandStore, activeBrandStyle } from "../stores/brand-store";
import { useRenderPrefs } from "../stores/render-prefs-store";
import { adjustCandidateBoundary } from "../../../shared/boundary";
import { clipDurationSec, isStitched } from "../../../shared/pieces";
import { PLATFORM_SPECS } from "../../../shared/platform-specs";
import { ClipReviewModal } from "./ClipReviewModal";
import { BrandStyleModal } from "./BrandStyleModal";
import { TranscriptPickModal } from "./TranscriptPickModal";
import type { Transcript, HighlightCandidate, RenderToggles, CaptionStyleChoice, FunnelStats, VisionStats, EmotionStats, DanmakuStats, VoiceTagStats, ClipLength, ReferenceInfo, ReviewedCandidate, ClipPiece } from "../../../shared/api-types";

/** Click-to-cycle order for the caption style chip. */
const CAPTION_CYCLE: CaptionStyleChoice[] = ["keyword", "pop", "minimal", "hormozi", "bubble", "karaoke", "none"];
const CAPTION_KEY: Record<CaptionStyleChoice, string> = {
  none: "captionNone",
  karaoke: "captionKaraoke",
  keyword: "captionKeyword",
  pop: "captionPop",
  hormozi: "captionHormozi",
  minimal: "captionMinimal",
  bubble: "captionBubble",
};

function formatClock(totalSeconds: number): string {
  const s = Math.floor(totalSeconds);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const BOUNDARY_KEY: Record<HighlightCandidate["boundary"], string> = {
  exact: "boundaryExact",
  anchored: "boundaryAnchored",
  segment: "boundarySegment",
  signal: "boundarySignal",
};

/**
 * 出片选项 chip:十几个开关同构,样式只在这里出一份。
 * shrink-0 + whitespace-nowrap 不是装饰——少了它们,一行摆不下时 flex 会把
 * chip 压得比文字还窄,中文逐字竖排、整条工具条撑破卡片(issue #3)。
 */
function OptChip({
  on,
  disabled,
  title,
  label,
  Icon,
  onClick,
}: {
  on: boolean;
  disabled?: boolean;
  title: string;
  label: string;
  Icon: typeof LuZap;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold whitespace-nowrap transition-colors disabled:opacity-40 ${
        on ? "border-ember/60 bg-ember/10 text-fg" : "border-line text-mut hover:border-mut"
      }`}
    >
      <Icon className={`h-3.5 w-3.5 ${on ? "text-ember" : ""}`} />
      {label}
    </button>
  );
}

export function HighlightsView({
  transcript,
  filePath,
  onBack,
  onExport,
  onTranscriptLabeled,
  auto,
}: {
  transcript: Transcript;
  /** Source path — lets the backend add audiovisual-signal evidence. */
  filePath?: string;
  onBack: () => void;
  onExport?: (clips: HighlightCandidate[], options: RenderToggles) => void;
  /** Lift the diarization-labeled transcript up so export colors captions by speaker. */
  onTranscriptLabeled?: (t: Transcript) => void;
  /** 托管 mode: export every candidate with default render options as soon as they land. */
  auto?: boolean;
}): React.JSX.Element {
  const t = useT("highlights");
  const lang = useLocaleStore((s) => s.locale);
  const { config, setConfig, prefilter, setPrefilter, vision, setVision } = useLlmStore();
  // browser preview (mock) needs no key; Electron needs a real endpoint
  const gateOpen = !isElectron() || isLlmReady(config);
  const [showGate, setShowGate] = useState(!gateOpen);
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<HighlightCandidate[] | null>(null);
  /** 本地初筛生效时的漏斗统计(结果页展示省了多少)。 */
  const [funnel, setFunnel] = useState<FunnelStats | null>(null);
  /** 视觉爆点信号生效时的抽帧统计(结果页展示看了多少帧)。 */
  const [visionStats, setVisionStats] = useState<VisionStats | null>(null);
  /** 表情峰值信号统计(零配置自动跑,有人脸才有)。 */
  const [emotionStats, setEmotionStats] = useState<EmotionStats | null>(null);
  /** 弹幕热度信号统计(视频旁同名 .xml 自动发现)。 */
  const [danmakuStats, setDanmakuStats] = useState<DanmakuStats | null>(null);
  const [voiceStats, setVoiceStats] = useState<VoiceTagStats | null>(null);
  /** 参考爆款:对标视频路径与实测画像(会话内有效——本地路径易失效,不持久化)。 */
  const [referencePath, setReferencePath] = useState<string | null>(null);
  const [referenceInfo, setReferenceInfo] = useState<ReferenceInfo | null>(null);
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // 出片偏好持久化:上次的开关组合下次直接生效(解构保持下方 JSX 引用不变)
  const { prefs, setPref } = useRenderPrefs();
  const { vertical, captionStyle, jumpCut, cleanFillers, cutRetakes, autoZoom, sfx, bgmPath, trimUi, titleCard, openingHook, coldOpen, flashForward, preciseAlign, alsoLandscape, normalizeLoudness, denoise, compilation, translate, publishCopy, subtitleFile, timeline, aigcLabel, publishPack, packPlatforms, variants, outDir, quality } = prefs;
  /** 出厂导出根目录(主进程才知道 ~/影片 在哪);用户没自选时显示它。 */
  const [defaultOutDir, setDefaultOutDir] = useState("");
  useEffect(() => {
    void getApi().defaultOutDir().then(setDefaultOutDir).catch(() => {});
  }, []);
  const pickOutDir = useCallback(async (): Promise<void> => {
    const dir = await getApi().selectDir();
    if (dir) setPref({ outDir: dir });
  }, [setPref]);
  // BGM 开关即选择器:没设过点开选文件,设过再点即清除(chip 标签显示文件名)
  const pickBgm = useCallback(async (): Promise<void> => {
    if (bgmPath) {
      setPref({ bgmPath: "" });
      return;
    }
    const p = await getApi().selectAudio();
    if (p) setPref({ bgmPath: p });
  }, [bgmPath, setPref]);
  const bgmName = bgmPath ? bgmPath.split(/[\\/]/).pop() ?? bgmPath : "";
  const [diarize, setDiarize] = useState(false);
  // 中文源译英,其余译中——短视频出海/引进的两个主方向
  const targetLang = (transcript.language || "").startsWith("zh") ? "en" : "zh";
  /** 标题即点即改:当前编辑中的候选 id。 */
  const [editingTitle, setEditingTitle] = useState<number | null>(null);
  /** 切片时长档(短=快节奏竖屏,长=B站/播客金句段);切换即重新检测,选择持久化。 */
  const clipLength = prefs.clipLength;
  const genreId = prefs.genreId;
  const genreCustom = prefs.genreCustom;
  /** 商品讲解模式:商品词列表(带货直播按商品选段),持久化本机。 */
  const [products, setProducts] = useState<string[]>(() => {
    try {
      const p = JSON.parse(localStorage.getItem("hotclip-products") ?? "[]");
      return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  });
  /** 审阅台当前打开的候选 id;null = 关闭。 */
  const [reviewId, setReviewId] = useState<number | null>(null);
  /** 端点当前真正提供的模型清单(点「拉取模型」才去问;换供应商即作废)。 */
  const [modelList, setModelList] = useState<string[]>([]);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState("");
  const fetchModels = useCallback(async (): Promise<void> => {
    setModelLoading(true);
    setModelError("");
    const res = await getApi().listLlmModels(config.baseUrl, config.apiKey);
    setModelList(res.ids);
    setModelError(res.error ?? "");
    setModelLoading(false);
  }, [config.baseUrl, config.apiKey]);
  /** 打开供应商面板那一刻的连接配置——确认时用来判断「换过没有」。 */
  const gateOpenedWith = useRef<string>("");
  const openLlmGate = useCallback((): void => {
    gateOpenedWith.current = `${config.baseUrl}|${config.model}`;
    setShowGate(true);
  }, [config.baseUrl, config.model]);
  /** 品牌样式模板弹窗。 */
  const [showBrand, setShowBrand] = useState(false);
  /** 文稿选段弹窗(文字剪视频)。 */
  const [showPick, setShowPick] = useState(false);
  const brandState = useBrandStore();
  const startedRef = useRef(false);

  const run = useCallback(async (useDiarize: boolean, lengthArg?: ClipLength, productsArg?: string[], referenceArg?: string | null): Promise<void> => {
    setDetecting(true);
    setError(null);
    try {
      const result = await getApi().detectHighlights(
        transcript,
        config,
        filePath,
        useDiarize,
        prefilter.enabled ? { baseUrl: prefilter.baseUrl, model: prefilter.model } : null,
        vision.enabled ? { baseUrl: vision.baseUrl, model: vision.model, apiKey: vision.apiKey || undefined } : null,
        lengthArg ?? clipLength,
        productsArg ?? products,
        // undefined = 沿用当前参考;null = 显式清掉
        referenceArg === undefined ? referencePath : referenceArg,
        { id: genreId, custom: genreCustom }
      );
      setCandidates(result.candidates);
      setFunnel(result.funnel ?? null);
      setVisionStats(result.vision ?? null);
      setEmotionStats(result.emotion ?? null);
      setDanmakuStats(result.danmaku ?? null);
      setVoiceStats(result.voice ?? null);
      setReferenceInfo(result.reference ?? null);
      setReferenceError(result.referenceError ?? null);
      // reviewer-approved clips are pre-selected; flagged ones start unchecked
      setSelected(new Set(result.candidates.filter((c) => c.recommended).map((c) => c.id)));
      // Lift the speaker-labeled transcript so export can color captions by speaker.
      if (result.transcript) onTranscriptLabeled?.(result.transcript);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDetecting(false);
    }
  }, [transcript, config, filePath, onTranscriptLabeled, prefilter, vision, clipLength, products, referencePath]);

  // 参考爆款:选一条对标视频带着它重新检测;已设置时再点即清除参考重检
  const toggleReference = useCallback(async (): Promise<void> => {
    if (referencePath) {
      setReferencePath(null);
      setReferenceInfo(null);
      setReferenceError(null);
      void run(diarize, undefined, undefined, null);
      return;
    }
    const p = await getApi().selectMedia();
    if (!p) return;
    setReferencePath(p);
    void run(diarize, undefined, undefined, p);
  }, [referencePath, diarize, run]);

  // 商品词提交:解析(逗号/顿号分隔)→ 持久化 → 变了就按新词重新检测
  const commitProducts = useCallback(
    (raw: string): void => {
      const next = [...new Set(raw.split(/[,，、;；]/).map((s) => s.trim()).filter(Boolean))].slice(0, 20);
      if (JSON.stringify(next) === JSON.stringify(products)) return;
      setProducts(next);
      try {
        localStorage.setItem("hotclip-products", JSON.stringify(next));
      } catch {
        /* 持久化尽力而为 */
      }
      void run(diarize, undefined, next);
    },
    [products, diarize, run]
  );

  // 时长档循环切换:短 → 标准 → 长,切换即按新档重新检测
  const LENGTH_CYCLE: ClipLength[] = ["standard", "short", "long"];
  const cycleLength = useCallback((): void => {
    const next = LENGTH_CYCLE[(LENGTH_CYCLE.indexOf(clipLength) + 1) % LENGTH_CYCLE.length];
    setPref({ clipLength: next });
    void run(diarize, next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipLength, diarize, run]);

  // Multi-speaker attribution: re-detect with diarization when toggled on.
  const toggleDiarize = useCallback((): void => {
    setDiarize((prev) => {
      const next = !prev;
      void run(next);
      return next;
    });
  }, [run]);

  const nudge = (id: number, edge: "start" | "end", dir: 1 | -1): void => {
    setCandidates((prev) => {
      if (!prev) return prev;
      return prev.map((c) => {
        if (c.id !== id) return c;
        const adjusted = adjustCandidateBoundary(transcript, c, edge, dir);
        // manual edits reset the boundary badge to sentence-aligned honesty
        return adjusted ? { ...c, ...adjusted, boundary: "segment" as const, manualBounds: true } : c;
      });
    });
  };

  const toggle = (id: number): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // 文稿选段成片:手动候选进同一条候选流(审阅台/微调/导出全都直接可用);
  // score=0 + manualBounds 让卡片亮「手动」徽标而不是硬编一个爆款分
  const addManualClip = useCallback((pieces: ClipPiece[], text: string, title: string): void => {
    const id = (candidates ?? []).reduce((m, c) => Math.max(m, c.id), 0) + 1;
    const cand: HighlightCandidate = {
      id,
      startSec: pieces[0].startSec,
      endSec: pieces[pieces.length - 1].endSec,
      pieces: pieces.length > 1 ? pieces : undefined,
      text,
      title,
      hook: "",
      score: 0,
      reason: "",
      boundary: "segment",
      keywords: [],
      recommended: true,
      reviewNote: "",
      manualBounds: true,
    };
    // 候选列表始终按时间排列(resultCount 的承诺),手动的也插进时间序里
    setCandidates((prev) => [...(prev ?? []), cand].sort((a, b) => a.startSec - b.startSec));
    setSelected((prev) => new Set(prev).add(id));
    setShowPick(false);
  }, [candidates]);

  useEffect(() => {
    if (!showGate && !startedRef.current) {
      startedRef.current = true;
      void run(false);
    }
  }, [showGate, run]);

  // 托管: ship every candidate with the default render stack, hands-off.
  const autoExported = useRef(false);
  useEffect(() => {
    const publishable = candidates?.filter((c) => c.recommended) ?? [];
    if (auto && onExport && publishable.length > 0 && !autoExported.current) {
      autoExported.current = true;
      // 托管出片同样吃品牌预设——一次配置,全自动也长自己的样子
      onExport(publishable, { vertical: true, captionStyle: "keyword", jumpCut: true, cleanFillers: true, trimUi: true, titleCard: true, openingHook: true, normalizeLoudness: true, brand: activeBrandStyle(brandState) });
    }
  }, [auto, candidates, onExport, brandState]);

  return (
    <div className="rise-in flex w-full max-w-2xl flex-col items-center">
      {/* ---- LLM settings gate ---- */}
      {showGate && (
        <section className="card w-full rounded-2xl p-6">
          <h2 className="flex items-center gap-2 text-xl font-extrabold tracking-tight">
            <LuKeyRound className="h-5 w-5 text-ember" />
            {t("llmTitle")}
          </h2>
          <p className="mt-2 text-[13px] leading-relaxed text-mut">{t("llmDesc")}</p>

          <div className="mt-5 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
            {LLM_PRESET_LIST.map((preset) => {
              const active = config.baseUrl === preset.baseUrl;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => {
                    setConfig({ baseUrl: preset.baseUrl, model: preset.model });
                    setModelList([]); // 换家了,上一家的模型清单立刻作废
                    setModelError("");
                  }}
                  className={`rounded-xl border px-3 py-2.5 text-left text-[12.5px] font-semibold transition-colors ${
                    active ? "border-ember/60 bg-ember/10 text-fg" : "border-line text-mut hover:border-mut"
                  }`}
                >
                  {preset.label}
                  <div className="mt-0.5 truncate text-[10.5px] font-normal text-mut">
                    {preset.baseUrl.replace(/^https?:\/\//, "")}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="mt-4 space-y-3">
            <label className="block">
              <span className="text-[11px] font-semibold text-mut">{t("llmBaseUrl")}</span>
              <input
                value={config.baseUrl}
                onChange={(e) => setConfig({ baseUrl: e.target.value })}
                className="mt-1 w-full rounded-lg border border-line bg-panel-2 px-3 py-2 text-[13px] outline-none focus:border-ember/60"
              />
            </label>
            <label className="block">
              <span className="text-[11px] font-semibold text-mut">{t("llmApiKey")}</span>
              <input
                type="password"
                value={config.apiKey}
                onChange={(e) => setConfig({ apiKey: e.target.value })}
                placeholder={t("llmKeyPlaceholder")}
                className="mt-1 w-full rounded-lg border border-line bg-panel-2 px-3 py-2 text-[13px] outline-none focus:border-ember/60"
              />
            </label>
            <label className="block">
              <span className="text-[11px] font-semibold text-mut">{t("llmModel")}</span>
              {/* 模型 id 会随厂商换代失效,所以给一个「问端点要真实清单」的按钮,
                  而不是让用户对着一个写死的名字猜 */}
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
                  onClick={fetchModels}
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
              {modelList.length > 0 && (
                <span className="mt-1 block text-[10.5px] text-mut/80">
                  {t("llmModelsFound", { n: modelList.length })}
                </span>
              )}
              {modelError && <span className="mt-1 block text-[10.5px] text-amber-400/90">{modelError}</span>}
            </label>
          </div>

          {/* 两级漏斗:本地小模型初筛(省云端 token) */}
          <div className="mt-4 rounded-xl border border-dashed border-line p-3.5">
            <button
              type="button"
              onClick={() => setPrefilter({ enabled: !prefilter.enabled })}
              className="flex w-full items-center justify-between text-left"
            >
              <span className="text-[12.5px] font-bold">{t("prefilterTitle")}</span>
              <span
                className={`relative h-4.5 w-8 shrink-0 rounded-full transition-colors ${
                  prefilter.enabled ? "flame-gradient" : "bg-line"
                }`}
              >
                <span
                  className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow transition-all ${
                    prefilter.enabled ? "left-4" : "left-0.5"
                  }`}
                />
              </span>
            </button>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-mut">{t("prefilterDesc")}</p>
            {prefilter.enabled && (
              <div className="mt-2.5 grid grid-cols-2 gap-2.5">
                <label className="block">
                  <span className="text-[11px] font-semibold text-mut">{t("llmBaseUrl")}</span>
                  <input
                    value={prefilter.baseUrl}
                    onChange={(e) => setPrefilter({ baseUrl: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-line bg-panel-2 px-3 py-2 text-[13px] outline-none focus:border-ember/60"
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] font-semibold text-mut">{t("llmModel")}</span>
                  <input
                    value={prefilter.model}
                    onChange={(e) => setPrefilter({ model: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-line bg-panel-2 px-3 py-2 text-[13px] outline-none focus:border-ember/60"
                  />
                </label>
              </div>
            )}
          </div>

          {/* 视觉爆点信号:端侧 VL 抽帧看画面(补文本看不见的画面梗) */}
          <div className="mt-3 rounded-xl border border-dashed border-line p-3.5">
            <button
              type="button"
              onClick={() => setVision({ enabled: !vision.enabled })}
              className="flex w-full items-center justify-between text-left"
            >
              <span className="text-[12.5px] font-bold">{t("visionTitle")}</span>
              <span
                className={`relative h-4.5 w-8 shrink-0 rounded-full transition-colors ${
                  vision.enabled ? "flame-gradient" : "bg-line"
                }`}
              >
                <span
                  className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow transition-all ${
                    vision.enabled ? "left-4" : "left-0.5"
                  }`}
                />
              </span>
            </button>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-mut">{t("visionDesc")}</p>
            {vision.enabled && (
              <div className="mt-2.5 grid grid-cols-2 gap-2.5">
                <label className="block">
                  <span className="text-[11px] font-semibold text-mut">{t("llmBaseUrl")}</span>
                  <input
                    value={vision.baseUrl}
                    onChange={(e) => setVision({ baseUrl: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-line bg-panel-2 px-3 py-2 text-[13px] outline-none focus:border-ember/60"
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] font-semibold text-mut">{t("llmModel")}</span>
                  <input
                    value={vision.model}
                    onChange={(e) => setVision({ model: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-line bg-panel-2 px-3 py-2 text-[13px] outline-none focus:border-ember/60"
                  />
                </label>
                {/* 云端视觉端点(Atlas 等)要 Key;本地 Ollama 留空 */}
                <label className="col-span-2 block">
                  <span className="text-[11px] font-semibold text-mut">{t("visionApiKey")}</span>
                  <input
                    type="password"
                    value={vision.apiKey ?? ""}
                    onChange={(e) => setVision({ apiKey: e.target.value })}
                    placeholder={t("visionApiKeyPlaceholder")}
                    className="mt-1 w-full rounded-lg border border-line bg-panel-2 px-3 py-2 text-[13px] outline-none focus:border-ember/60"
                  />
                </label>
              </div>
            )}
          </div>

          <div className="mt-5 flex items-center justify-between">
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
              disabled={!isLlmReady(config)}
              onClick={() => {
                setShowGate(false);
                // 换了供应商/模型还留着上一家的结果没意义——直接按新配置重跑
                const changed = gateOpenedWith.current !== "" && gateOpenedWith.current !== `${config.baseUrl}|${config.model}`;
                if (changed && candidates) void run(diarize);
              }}
              className="btn-flame rounded-lg px-6 py-2.5 text-[14px] font-bold text-white disabled:opacity-40"
            >
              {t("llmStart")}
            </button>
          </div>
        </section>
      )}

      {/* ---- detecting ---- */}
      {!showGate && detecting && (
        <div className="card mt-2 w-full rounded-2xl p-8 text-center">
          <LuSparkles className="mx-auto h-8 w-8 animate-pulse text-ember" />
          <p className="shimmer mt-4 text-[14px] font-semibold">{t("detecting")}</p>
        </div>
      )}

      {/* ---- error ---- */}
      {!showGate && error && !detecting && (
        <div className="card mt-2 w-full rounded-2xl p-6 text-center">
          <p className="text-sm break-all text-red-400">{t("failed", { msg: error })}</p>
          <div className="mt-4 flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={openLlmGate}
              className="rounded-lg border border-line px-4 py-2 text-sm text-mut transition-colors hover:border-mut hover:text-fg"
            >
              {t("llmTitle")}
            </button>
            <button type="button" onClick={() => run(diarize)} className="btn-flame rounded-lg px-5 py-2 text-sm font-bold text-white">
              {t("retry")}
            </button>
          </div>
        </div>
      )}

      {/* ---- results ---- */}
      {candidates && !detecting && (
        <section className="w-full">
          {/* 标题区与工具条同理:窄窗口下换行,不许互相挤压(issue #3) */}
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              <h1 className="flex items-center gap-2 text-2xl font-extrabold tracking-tight">
                <LuFlame className="h-6 w-6 text-ember" />
                {t("title")}
              </h1>
              <p className="mt-1.5 text-[13px] text-mut">{t("resultCount", { n: candidates.length })}</p>
              {funnel && (
                <p className="mt-1 text-[11.5px] text-emerald-400/90">
                  {t("funnelSaved", {
                    total: (funnel.totalChars / 1000).toFixed(1),
                    kept: (funnel.keptChars / 1000).toFixed(1),
                    pct: Math.round((1 - funnel.keptChars / Math.max(1, funnel.totalChars)) * 100),
                  })}
                </p>
              )}
              {visionStats && (
                <p className="mt-1 text-[11.5px] text-sky-400/90">
                  {t("visionScanned", {
                    frames: visionStats.framesScored,
                    peaks: visionStats.peakCount,
                  })}
                </p>
              )}
              {emotionStats && emotionStats.peakCount > 0 && (
                <p className="mt-1 text-[11.5px] text-amber-300/90">
                  {t("emotionScanned", {
                    faces: emotionStats.facesScored,
                    peaks: emotionStats.peakCount,
                  })}
                </p>
              )}
              {danmakuStats && danmakuStats.peakCount > 0 && (
                <p className="mt-1 text-[11.5px] text-pink-400/90">
                  {t("danmakuScanned", {
                    count: danmakuStats.count,
                    peaks: danmakuStats.peakCount,
                  })}
                </p>
              )}
              {voiceStats && voiceStats.emotionPeakCount + voiceStats.eventPeakCount > 0 && (
                <p className="mt-1 text-[11.5px] text-teal-300/90">
                  {t("voiceScanned", {
                    windows: voiceStats.windowsScored,
                    emo: voiceStats.emotionPeakCount,
                    evt: voiceStats.eventPeakCount,
                  })}
                </p>
              )}
              {referenceInfo && (
                <p className="mt-1 text-[11.5px] text-violet-400/90">
                  {t("refProfile", {
                    dur: Math.round(referenceInfo.durationSec),
                    rate: referenceInfo.speechRate,
                    unit: referenceInfo.zh ? t("refUnitZh") : t("refUnitEn"),
                    cuts: referenceInfo.cutsPerMin !== null ? t("refCuts", { n: referenceInfo.cutsPerMin }) : "",
                    hook: referenceInfo.hookLine.slice(0, 16),
                  })}
                </p>
              )}
              {referenceError && (
                <p className="mt-1 text-[11.5px] text-amber-400/90">{t("refFailed", { msg: referenceError })}</p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {/* AI 模型入口:此前只有「检测报错」那一条分支能打开供应商面板——
                  配过一次之后就再也换不了供应商/模型了。常驻在这里,顺便把当前
                  用的模型写在按钮上(出了坏结果时,第一件事就是想知道用的是谁) */}
              <button
                type="button"
                title={t("llmSwitchHint", { url: config.baseUrl })}
                onClick={openLlmGate}
                className="inline-flex max-w-[13rem] shrink-0 items-center gap-1.5 rounded-lg border border-line px-3.5 py-2 text-xs font-semibold whitespace-nowrap text-mut transition-colors hover:border-mut hover:text-fg"
              >
                <LuKeyRound className="h-3.5 w-3.5" />
                <span className="truncate">{config.model || t("llmSwitch")}</span>
              </button>
              <button
                type="button"
                title={referencePath ? t("refHintOn", { name: referencePath.split(/[\\/]/).pop() ?? "" }) : t("refHint")}
                onClick={() => void toggleReference()}
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3.5 py-2 text-xs font-semibold whitespace-nowrap transition-colors ${
                  referencePath ? "border-ember/60 bg-ember/10 text-fg" : "border-line text-mut hover:border-mut hover:text-fg"
                }`}
              >
                <LuTarget className={`h-3.5 w-3.5 ${referencePath ? "text-ember" : ""}`} />
                {t("refButton")}
              </button>
              <button
                type="button"
                title={t("lengthHint")}
                onClick={cycleLength}
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3.5 py-2 text-xs font-semibold whitespace-nowrap transition-colors ${
                  clipLength !== "standard" ? "border-ember/60 bg-ember/10 text-fg" : "border-line text-mut hover:border-mut hover:text-fg"
                }`}
              >
                <LuClock3 className={`h-3.5 w-3.5 ${clipLength !== "standard" ? "text-ember" : ""}`} />
                {t(clipLength === "short" ? "lengthShort" : clipLength === "long" ? "lengthLong" : "lengthStandard")}
              </button>
              {/* 品类判据:选预设或自己写。不选也没关系——提示词里已让模型先自判内容类型 */}
              <select
                value={genreId}
                title={t("genreHint")}
                onChange={(e) => setPref({ genreId: e.target.value })}
                className={`shrink-0 rounded-lg border px-2.5 py-2 text-xs font-semibold outline-none transition-colors ${
                  genreId !== "auto" ? "border-ember/60 bg-ember/10 text-fg" : "border-line text-mut hover:border-mut"
                }`}
              >
                {GENRE_PRESETS.map((g) => (
                  <option key={g.id} value={g.id}>
                    {lang === "zh" ? g.labelZh : g.labelEn}
                  </option>
                ))}
              </select>
              {(genreId === "custom" || genreCustom.trim()) && (
                <input
                  defaultValue={genreCustom}
                  placeholder={t("genrePlaceholder")}
                  title={t("genreCustomHint")}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                  onBlur={(e) => setPref({ genreCustom: e.target.value.slice(0, GENRE_CUSTOM_MAX_CHARS) })}
                  className="w-52 shrink-0 rounded-lg border border-line px-3 py-2 text-xs outline-none transition-colors focus:border-ember/60"
                />
              )}
              <input
                defaultValue={products.join(",")}
                placeholder={t("productsPlaceholder")}
                title={t("productsHint")}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
                onBlur={(e) => commitProducts(e.target.value)}
                className={`w-44 shrink-0 rounded-lg border px-3 py-2 text-xs outline-none transition-colors focus:border-ember/60 ${
                  products.length > 0 ? "border-ember/60 bg-ember/10 text-fg" : "border-line bg-panel-2 text-mut"
                }`}
              />
              <button
                type="button"
                title={t("optDiarizeHint")}
                onClick={toggleDiarize}
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3.5 py-2 text-xs font-semibold whitespace-nowrap transition-colors ${
                  diarize ? "border-ember/60 bg-ember/10 text-fg" : "border-line text-mut hover:border-mut hover:text-fg"
                }`}
              >
                <LuUsers className={`h-3.5 w-3.5 ${diarize ? "text-ember" : ""}`} />
                {t("optDiarize")}
              </button>
              <button
                type="button"
                title={t("pickHint")}
                onClick={() => setShowPick(true)}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-3.5 py-2 text-xs font-semibold whitespace-nowrap text-mut transition-colors hover:border-mut hover:text-fg"
              >
                <LuTextSelect className="h-3.5 w-3.5" />
                {t("pickButton")}
              </button>
              <button
                type="button"
                onClick={onBack}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-3.5 py-2 text-xs whitespace-nowrap text-mut transition-colors hover:border-mut hover:text-fg"
              >
                <LuArrowLeft className="h-3.5 w-3.5" />
                {t("retry")}
              </button>
            </div>
          </div>

          {candidates.length === 0 && <p className="card mt-5 rounded-2xl p-6 text-center text-sm text-mut">{t("empty")}</p>}

          <div className="mt-5 space-y-3.5">
            {candidates.map((c, i) => (
              <article
                key={c.id}
                onClick={() => toggle(c.id)}
                className={`card card-hover rise-in rise-in-${Math.min(i + 1, 3)} cursor-pointer rounded-2xl p-5 ${
                  selected.has(c.id) ? "!border-ember/50" : "opacity-60"
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex min-w-0 items-start gap-3">
                    <span
                      className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors ${
                        selected.has(c.id) ? "flame-gradient border-transparent text-white" : "border-line text-transparent"
                      }`}
                    >
                      <LuCheck className="h-3.5 w-3.5" />
                    </span>
                    {editingTitle === c.id ? (
                      <input
                        autoFocus
                        defaultValue={c.title}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                          if (e.key === "Escape") setEditingTitle(null);
                        }}
                        onBlur={(e) => {
                          const v = e.target.value.trim();
                          if (v) {
                            setCandidates((prev) => prev?.map((x) => (x.id === c.id ? { ...x, title: v } : x)) ?? prev);
                          }
                          setEditingTitle(null);
                        }}
                        className="w-full rounded-lg border border-ember/60 bg-panel-2 px-2 py-1 text-[16px] font-bold outline-none"
                      />
                    ) : (
                      <h3 className="group/title flex min-w-0 items-center gap-1.5 text-[16px] leading-snug font-bold">
                        <span className="min-w-0">{c.title}</span>
                        <button
                          type="button"
                          title={t("editTitleHint")}
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingTitle(c.id);
                          }}
                          className="shrink-0 rounded p-0.5 text-mut opacity-0 transition-opacity group-hover/title:opacity-100 hover:text-fg"
                        >
                          <LuPencil className="h-3.5 w-3.5" />
                        </button>
                      </h3>
                    )}
                  </div>
                  {/* 手动选段没有爆款分——亮「手动」徽标,不硬编一个假分数 */}
                  {c.score > 0 ? (
                    <span className="flame-gradient flex shrink-0 items-center gap-1 rounded-full px-3 py-1 text-xs font-extrabold text-white">
                      <LuFlame className="h-3 w-3" />
                      {c.score}
                    </span>
                  ) : (
                    <span className="chip flex shrink-0 items-center gap-1 rounded-full px-3 py-1 text-xs font-bold text-mut">
                      <LuTextSelect className="h-3 w-3" />
                      {t("manualChip")}
                    </span>
                  )}
                </div>

                {c.hook && (
                  <p className="mt-3 flex items-start gap-2 text-[13.5px] leading-relaxed">
                    <LuQuote className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ember" />
                    <span className="text-fg/90">{c.hook}</span>
                  </p>
                )}
                {c.reason && (
                  <p className="mt-2 flex items-start gap-2 text-[12.5px] leading-relaxed text-mut">
                    <LuSparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ember/70" />
                    {c.reason}
                  </p>
                )}
                {/* 商品讲解模式:这条候选命中的商品词 */}
                {products.length > 0 && c.keywords.some((k) => products.includes(k)) && (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {c.keywords.filter((k) => products.includes(k)).map((k) => (
                      <span key={k} className="chip inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10.5px] text-ember">
                        <LuShoppingCart className="h-3 w-3" />
                        {k}
                      </span>
                    ))}
                  </div>
                )}
                {c.scoreDims && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {(
                      [
                        ["dimHook", c.scoreDims.hook, c.dimNotes?.hook],
                        ["dimFlow", c.scoreDims.flow, c.dimNotes?.flow],
                        ["dimValue", c.scoreDims.value, c.dimNotes?.value],
                        ["dimTrend", c.scoreDims.trend, c.dimNotes?.trend],
                      ] as const
                    ).map(([key, val, note]) => (
                      <span
                        key={key}
                        title={note || undefined}
                        className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${
                          val >= 75 ? "bg-ember/15 text-ember" : val >= 50 ? "bg-white/5 text-fg/70" : "bg-white/5 text-mut"
                        }`}
                      >
                        {t(key)} {val}
                      </span>
                    ))}
                  </div>
                )}
                {c.teaser && (
                  <p className="mt-2 text-[12px] leading-relaxed text-fg/60">
                    <span className="mr-1.5 rounded bg-white/5 px-1.5 py-0.5 text-[10.5px] text-mut">{t("teaserLabel")}</span>
                    {c.teaser}
                  </p>
                )}
                {!c.recommended && (
                  <p className="mt-2 flex items-start gap-2 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-[12px] leading-relaxed text-amber-400">
                    <LuTriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {t("reviewWeak")}
                    {c.reviewNote ? `:${c.reviewNote}` : ""}
                  </p>
                )}

                <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-dashed border-line pt-3.5 text-[11px] text-mut">
                  <button
                    type="button"
                    title={t("reviewOpenHint")}
                    onClick={(e) => {
                      e.stopPropagation();
                      setReviewId(c.id);
                    }}
                    className="chip flex items-center gap-1 rounded-md px-2 py-0.5 font-semibold text-ember transition-colors hover:text-fg"
                  >
                    <LuPlay className="h-3 w-3" />
                    {t("reviewOpen")}
                  </button>
                  {([
                    ["start", -1, LuChevronLeft], ["start", 1, LuChevronRight],
                  ] as const).map(([edge, dir, Icon]) => (
                    <button
                      key={`s${dir}`}
                      type="button"
                      title={t(dir === -1 ? "nudgeStartBack" : "nudgeStartFwd")}
                      onClick={(e) => { e.stopPropagation(); nudge(c.id, edge, dir); }}
                      className="chip rounded-md p-1 transition-colors hover:text-fg"
                    >
                      <Icon className="h-3 w-3" />
                    </button>
                  ))}
                  <span className="chip flex items-center gap-1 rounded-md px-2 py-0.5 font-mono">
                    <LuClock3 className="h-3 w-3" />
                    {formatClock(c.startSec)} → {formatClock(c.endSec)}
                  </span>
                  {([
                    ["end", -1, LuChevronLeft], ["end", 1, LuChevronRight],
                  ] as const).map(([edge, dir, Icon]) => (
                    <button
                      key={`e${dir}`}
                      type="button"
                      title={t(dir === -1 ? "nudgeEndBack" : "nudgeEndFwd")}
                      onClick={(e) => { e.stopPropagation(); nudge(c.id, edge, dir); }}
                      className="chip rounded-md p-1 transition-colors hover:text-fg"
                    >
                      <Icon className="h-3 w-3" />
                    </button>
                  ))}
                  <span className="chip rounded-md px-2 py-0.5 font-semibold">
                    {t("durationChip", { n: Math.round(clipDurationSec(c)) })}
                  </span>
                  {/* 拼接片:必须一眼看出「这条不是一段连续录像」——断章取义的风险都在这里 */}
                  {isStitched(c.pieces) && (
                    <span
                      className="chip flex items-center gap-1 rounded-md px-2 py-0.5 font-semibold text-ember"
                      title={t("stitchedHint")}
                    >
                      <LuScissorsLineDashed className="h-3 w-3" />
                      {t("stitchedChip", { n: c.pieces!.length })}
                    </span>
                  )}
                  <span className="chip flex items-center gap-1 rounded-md px-2 py-0.5">
                    <LuCrosshair className="h-3 w-3" />
                    {t(BOUNDARY_KEY[c.boundary])}
                  </span>
                </div>
              </article>
            ))}
          </div>

          {onExport && candidates.length > 0 && (
            <div className="card action-bar sticky bottom-4 mt-6 flex flex-col gap-3 rounded-2xl px-5 py-3.5 shadow-2xl backdrop-blur-xl">
              {/* 选项一排排铺开:必须能换行,窗口再窄也不许把 chip 挤扁(issue #3);
                  行数多到吃掉半屏时内部滚动,底下的「出片」按钮永远露在外面 */}
              <div className="flex max-h-[34vh] flex-wrap items-center gap-2 overflow-y-auto">
                {(
                  [
                    { key: "optBrand", on: Boolean(activeBrandStyle(brandState)), Icon: LuPalette, label: t("optBrand"), act: () => setShowBrand(true) },
                    { key: "optVertical", on: vertical, Icon: LuSmartphone, label: t("optVertical"), act: () => setPref({ vertical: !vertical }) },
                    { key: "optAlsoLandscape", on: alsoLandscape && vertical, disabled: !vertical, Icon: LuMonitor, label: t("optAlsoLandscape"), act: () => setPref({ alsoLandscape: !alsoLandscape }) },
                    { key: "optTrimUi", on: trimUi, Icon: LuEraser, label: t("optTrimUi"), act: () => setPref({ trimUi: !trimUi }) },
                    { key: "optTitleCard", on: titleCard, Icon: LuType, label: t("optTitleCard"), act: () => setPref({ titleCard: !titleCard }) },
                    { key: "optOpeningHook", on: openingHook, Icon: LuZap, label: t("optOpeningHook"), act: () => setPref({ openingHook: !openingHook }) },
                    { key: "optColdOpen", on: coldOpen, Icon: LuFastForward, label: t("optColdOpen"), act: () => setPref({ coldOpen: !coldOpen }) },
                    { key: "optFlash", on: flashForward, Icon: LuZap, label: t("optFlash"), act: () => setPref({ flashForward: !flashForward }) },
                    { key: "optJumpCut", on: jumpCut, Icon: LuFastForward, label: t("optJumpCut"), act: () => setPref({ jumpCut: !jumpCut }) },
                    { key: "optAlign", on: preciseAlign, Icon: LuCrosshair, label: t("optAlign"), act: () => setPref({ preciseAlign: !preciseAlign }) },
                    { key: "optCleanFillers", on: cleanFillers, Icon: LuEraser, label: t("optCleanFillers"), act: () => setPref({ cleanFillers: !cleanFillers }) },
                    { key: "optCutRetakes", on: cutRetakes, Icon: LuRepeat2, label: t("optCutRetakes"), act: () => setPref({ cutRetakes: !cutRetakes }) },
                    { key: "optAutoZoom", on: autoZoom && vertical, disabled: !vertical, Icon: LuScan, label: t("optAutoZoom"), act: () => setPref({ autoZoom: !autoZoom }) },
                    { key: "optLoudness", on: normalizeLoudness, Icon: LuVolume2, label: t("optLoudness"), act: () => setPref({ normalizeLoudness: !normalizeLoudness }) },
                    { key: "optDenoise", on: denoise, Icon: LuAudioWaveform, label: t("optDenoise"), act: () => setPref({ denoise: !denoise }) },
                    { key: "optSfx", on: sfx, Icon: LuBell, label: t("optSfx"), act: () => setPref({ sfx: !sfx }) },
                    { key: "optBgm", on: Boolean(bgmPath), Icon: LuMusic, label: bgmName ? t("optBgmOn", { name: bgmName }) : t("optBgm"), act: () => void pickBgm() },
                    { key: "optTranslate", on: translate, Icon: LuLanguages, label: t(targetLang === "en" ? "optTranslateEn" : "optTranslateZh"), act: () => setPref({ translate: !translate }) },
                    { key: "optPublish", on: publishCopy, Icon: LuMegaphone, label: t("optPublish"), act: () => setPref({ publishCopy: !publishCopy }) },
                    { key: "optSrt", on: subtitleFile, Icon: LuFileText, label: t("optSrt"), act: () => setPref({ subtitleFile: !subtitleFile }) },
                    { key: "optTimeline", on: timeline, Icon: LuFilm, label: t("optTimeline"), act: () => setPref({ timeline: !timeline }) },
                    { key: "optCompilation", on: compilation, Icon: LuListVideo, label: t("optCompilation"), act: () => setPref({ compilation: !compilation }) },
                    { key: "optAigc", on: aigcLabel, Icon: LuBadgeCheck, label: t("optAigc"), act: () => setPref({ aigcLabel: !aigcLabel }) },
                    // 一片多版:点一下循环 关→2版→3版(标签实时显示档位)
                    {
                      key: "optVariants",
                      on: variants > 1,
                      Icon: LuLayers,
                      label: variants > 1 ? t("optVariantsN", { n: variants }) : t("optVariants"),
                      act: () => setPref({ variants: variants >= 3 ? 1 : variants + 1 }),
                    },
                    { key: "optPack", on: publishPack, Icon: LuPackage, label: t("optPack"), act: () => setPref({ publishPack: !publishPack }) },
                    {
                      key: "captionStyle",
                      on: captionStyle !== "none",
                      Icon: LuCaptions,
                      label: t(CAPTION_KEY[captionStyle]),
                      act: () => setPref({ captionStyle: CAPTION_CYCLE[(CAPTION_CYCLE.indexOf(captionStyle) + 1) % CAPTION_CYCLE.length] }),
                    },
                  ] as const
                ).map((o) => (
                  <OptChip
                    key={o.key}
                    on={o.on}
                    disabled={"disabled" in o ? o.disabled : false}
                    title={t(`${o.key}Hint`)}
                    label={o.label}
                    Icon={o.Icon}
                    onClick={o.act}
                  />
                ))}
              </div>
              {/* 发布包平台多选:开了发布包才展开;每个平台 hover 有规格备注 */}
              {publishPack && (
                <div className="flex flex-wrap items-center gap-1.5 border-t border-dashed border-line pt-2.5">
                  <span className="text-[11px] font-semibold text-mut">{t("packPlatformsLabel")}</span>
                  {PLATFORM_SPECS.map((p) => {
                    const on = packPlatforms.includes(p.id);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        title={p.noteZh}
                        onClick={() =>
                          setPref({ packPlatforms: on ? packPlatforms.filter((x) => x !== p.id) : [...packPlatforms, p.id] })
                        }
                        className={`chip rounded-md px-2 py-0.5 text-[12px] font-semibold transition-colors ${
                          on ? "border-ember/60 bg-ember/10 text-fg" : "text-mut hover:text-fg"
                        }`}
                      >
                        {lang === "zh" ? p.name.zh : p.name.en}
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-dashed border-line pt-3">
                <div className="min-w-0">
                  <span className="text-[13px] font-semibold text-mut">{t("selectedCount", { n: selected.size })}</span>
                  {/* 成片落在哪儿:默认 ~/影片/HotClip,可改可复位(issue #3)——
                      「文件到底导到哪去了」是新手第一困惑,写在按钮边上最省事 */}
                  <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-mut/80">
                    <LuFolderOpen className="h-3 w-3 shrink-0" />
                    <span className="truncate" title={outDir || defaultOutDir}>
                      {t("outDirLabel", { dir: outDir || defaultOutDir || "…" })}
                    </span>
                    {isElectron() && (
                      <button
                        type="button"
                        onClick={() => void pickOutDir()}
                        className="shrink-0 font-semibold text-ember/90 underline-offset-2 hover:underline"
                      >
                        {t("outDirChange")}
                      </button>
                    )}
                    {isElectron() && outDir && (
                      <button
                        type="button"
                        onClick={() => setPref({ outDir: "" })}
                        className="shrink-0 text-mut underline-offset-2 hover:text-fg hover:underline"
                      >
                        {t("outDirReset")}
                      </button>
                    )}
                  </p>
                </div>
              <button
                type="button"
                disabled={selected.size === 0}
                onClick={() => {
                  // 审阅反馈回流:本场的采用/否决落本地偏好档(尽力而为,失败不挡导出)
                  const summarize = (list: HighlightCandidate[]): ReviewedCandidate[] =>
                    list.map((c) => ({ title: c.title, hook: c.hook, score: c.score, durationSec: Math.round(clipDurationSec(c)), keywords: c.keywords.slice(0, 5) }));
                  void getApi()
                    .recordReview(filePath ?? "", summarize(candidates.filter((c) => selected.has(c.id))), summarize(candidates.filter((c) => !selected.has(c.id))))
                    .catch(() => {});
                  onExport(candidates.filter((c) => selected.has(c.id)), { vertical, captionStyle, jumpCut, cleanFillers, cutRetakes, autoZoom, sfx, bgmPath: bgmPath || undefined, genreId, preciseAlign, trimUi, titleCard, openingHook, coldOpen, flashForward, alsoLandscape, normalizeLoudness, denoise, compilation, brand: activeBrandStyle(brandState), translate: translate ? { targetLang, llm: config } : undefined, publishCopy: publishCopy ? { llm: config } : undefined, subtitleFile, timeline, aigcLabel, publishPack: publishPack && packPlatforms.length > 0 ? packPlatforms : undefined, variants: variants > 1 ? { count: variants, llm: config } : undefined, outDir, quality });
                }}
                className="btn-flame inline-flex shrink-0 items-center gap-1.5 rounded-lg px-6 py-2.5 text-[14px] font-bold whitespace-nowrap text-white disabled:opacity-40"
              >
                <LuScissors className="h-4 w-4" />
                {t("exportSelected")}
              </button>
              </div>
            </div>
          )}

          {/* ---- 品牌样式模板 ---- */}
          {showBrand && <BrandStyleModal onClose={() => setShowBrand(false)} />}

          {/* ---- 文稿选段:整篇逐句稿点句成片(文字剪视频) ---- */}
          {showPick && (
            <TranscriptPickModal transcript={transcript} onAdd={addManualClip} onClose={() => setShowPick(false)} />
          )}

          {/* ---- 审阅台:视频预览 + 波形时间轴,拖拽定切点 ---- */}
          {(() => {
            const reviewing = reviewId !== null ? candidates.find((c) => c.id === reviewId) : undefined;
            if (!reviewing) return null;
            return (
              <ClipReviewModal
                // 按候选 id 重建:切换候选时状态(切点/段清单)必须重新初始化,
                // 复用实例会把上一条的切点当成这一条的「已改动」
                key={reviewing.id}
                clip={reviewing}
                transcript={transcript}
                filePath={filePath}
                durationSec={transcript.durationSec}
                onClose={() => setReviewId(null)}
                onSave={(patch) => {
                  setCandidates(
                    (prev) =>
                      prev?.map((c) =>
                        c.id === reviewing.id
                          ? { ...c, ...patch, boundary: "segment" as const, manualBounds: true }
                          : c
                      ) ?? prev
                  );
                  setReviewId(null);
                }}
              />
            );
          })()}
        </section>
      )}
    </div>
  );
}
