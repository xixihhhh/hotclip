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
  LuCrosshair,
  LuKeyRound,
  LuExternalLink,
  LuCheck,
  LuScissors,
  LuSmartphone,
  LuCaptions,
  LuFastForward,
  LuEraser,
  LuUsers,
  LuTriangleAlert,
  LuType,
  LuZap,
  LuVolume2,
  LuAudioWaveform,
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
} from "react-icons/lu";
import { useT } from "../i18n/store";
import { getApi, isElectron } from "../api/provider";
import { useLlmStore, isLlmReady, LLM_PRESETS } from "../stores/llm-store";
import { useBrandStore, activeBrandStyle } from "../stores/brand-store";
import { useRenderPrefs } from "../stores/render-prefs-store";
import { adjustClipBoundary } from "../../../shared/boundary";
import { ClipReviewModal } from "./ClipReviewModal";
import { BrandStyleModal } from "./BrandStyleModal";
import type { Transcript, HighlightCandidate, RenderToggles, CaptionStyleChoice, FunnelStats, VisionStats, EmotionStats, DanmakuStats, ClipLength } from "../../../shared/api-types";

/** Click-to-cycle order for the caption style chip. */
const CAPTION_CYCLE: CaptionStyleChoice[] = ["karaoke", "keyword", "pop", "bubble", "none"];
const CAPTION_KEY: Record<CaptionStyleChoice, string> = {
  none: "captionNone",
  karaoke: "captionKaraoke",
  keyword: "captionKeyword",
  pop: "captionPop",
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
};

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
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // 出片偏好持久化:上次的开关组合下次直接生效(解构保持下方 JSX 引用不变)
  const { prefs, setPref } = useRenderPrefs();
  const { vertical, captionStyle, jumpCut, cleanFillers, trimUi, titleCard, openingHook, normalizeLoudness, denoise, translate, publishCopy, subtitleFile, timeline, aigcLabel } = prefs;
  const [diarize, setDiarize] = useState(false);
  // 中文源译英,其余译中——短视频出海/引进的两个主方向
  const targetLang = (transcript.language || "").startsWith("zh") ? "en" : "zh";
  /** 标题即点即改:当前编辑中的候选 id。 */
  const [editingTitle, setEditingTitle] = useState<number | null>(null);
  /** 切片时长档(短=快节奏竖屏,长=B站/播客金句段);切换即重新检测,选择持久化。 */
  const clipLength = prefs.clipLength;
  /** 审阅台当前打开的候选 id;null = 关闭。 */
  const [reviewId, setReviewId] = useState<number | null>(null);
  /** 品牌样式模板弹窗。 */
  const [showBrand, setShowBrand] = useState(false);
  const brandState = useBrandStore();
  const startedRef = useRef(false);

  const run = useCallback(async (useDiarize: boolean, lengthArg?: ClipLength): Promise<void> => {
    setDetecting(true);
    setError(null);
    try {
      const result = await getApi().detectHighlights(
        transcript,
        config,
        filePath,
        useDiarize,
        prefilter.enabled ? { baseUrl: prefilter.baseUrl, model: prefilter.model } : null,
        vision.enabled ? { baseUrl: vision.baseUrl, model: vision.model } : null,
        lengthArg ?? clipLength
      );
      setCandidates(result.candidates);
      setFunnel(result.funnel ?? null);
      setVisionStats(result.vision ?? null);
      setEmotionStats(result.emotion ?? null);
      setDanmakuStats(result.danmaku ?? null);
      // reviewer-approved clips are pre-selected; flagged ones start unchecked
      setSelected(new Set(result.candidates.filter((c) => c.recommended).map((c) => c.id)));
      // Lift the speaker-labeled transcript so export can color captions by speaker.
      if (result.transcript) onTranscriptLabeled?.(result.transcript);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDetecting(false);
    }
  }, [transcript, config, filePath, onTranscriptLabeled, prefilter, vision, clipLength]);

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
        const adjusted = adjustClipBoundary(transcript, c, edge, dir);
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
      onExport(publishable, { vertical: true, captionStyle: "karaoke", jumpCut: true, cleanFillers: true, trimUi: true, titleCard: true, openingHook: true, normalizeLoudness: true, brand: activeBrandStyle(brandState) });
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

          <div className="mt-5 grid grid-cols-2 gap-3">
            {Object.entries(LLM_PRESETS).map(([key, preset]) => {
              const active = config.baseUrl === preset.baseUrl;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setConfig({ baseUrl: preset.baseUrl, model: preset.model })}
                  className={`rounded-xl border px-4 py-3 text-left text-[13px] font-semibold transition-colors ${
                    active ? "border-ember/60 bg-ember/10 text-fg" : "border-line text-mut hover:border-mut"
                  }`}
                >
                  {preset.label}
                  <div className="mt-0.5 truncate text-[11px] font-normal text-mut">{preset.baseUrl}</div>
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
              <input
                value={config.model}
                onChange={(e) => setConfig({ model: e.target.value })}
                className="mt-1 w-full rounded-lg border border-line bg-panel-2 px-3 py-2 text-[13px] outline-none focus:border-ember/60"
              />
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
              </div>
            )}
          </div>

          <div className="mt-5 flex items-center justify-between">
            <a
              href={LLM_PRESETS.atlas.keyUrl}
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
              onClick={() => setShowGate(false)}
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
              onClick={() => setShowGate(true)}
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
          <div className="flex items-end justify-between">
            <div>
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
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                title={t("lengthHint")}
                onClick={cycleLength}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-3.5 py-2 text-xs font-semibold transition-colors ${
                  clipLength !== "standard" ? "border-ember/60 bg-ember/10 text-fg" : "border-line text-mut hover:border-mut hover:text-fg"
                }`}
              >
                <LuClock3 className={`h-3.5 w-3.5 ${clipLength !== "standard" ? "text-ember" : ""}`} />
                {t(clipLength === "short" ? "lengthShort" : clipLength === "long" ? "lengthLong" : "lengthStandard")}
              </button>
              <button
                type="button"
                title={t("optDiarizeHint")}
                onClick={toggleDiarize}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-3.5 py-2 text-xs font-semibold transition-colors ${
                  diarize ? "border-ember/60 bg-ember/10 text-fg" : "border-line text-mut hover:border-mut hover:text-fg"
                }`}
              >
                <LuUsers className={`h-3.5 w-3.5 ${diarize ? "text-ember" : ""}`} />
                {t("optDiarize")}
              </button>
              <button
                type="button"
                onClick={onBack}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3.5 py-2 text-xs text-mut transition-colors hover:border-mut hover:text-fg"
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
                  <span className="flame-gradient flex shrink-0 items-center gap-1 rounded-full px-3 py-1 text-xs font-extrabold text-white">
                    <LuFlame className="h-3 w-3" />
                    {c.score}
                  </span>
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
                    {t("durationChip", { n: Math.round(c.endSec - c.startSec) })}
                  </span>
                  <span className="chip flex items-center gap-1 rounded-md px-2 py-0.5">
                    <LuCrosshair className="h-3 w-3" />
                    {t(BOUNDARY_KEY[c.boundary])}
                  </span>
                </div>
              </article>
            ))}
          </div>

          {onExport && candidates.length > 0 && (
            <div className="card sticky bottom-4 mt-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl px-5 py-3.5 shadow-2xl backdrop-blur-xl">
              <span className="text-[13px] font-semibold text-mut">{t("selectedCount", { n: selected.size })}</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  title={t("optBrandHint")}
                  onClick={() => setShowBrand(true)}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-colors ${
                    activeBrandStyle(brandState) ? "border-ember/60 bg-ember/10 text-fg" : "border-line text-mut hover:border-mut"
                  }`}
                >
                  <LuPalette className={`h-3.5 w-3.5 ${activeBrandStyle(brandState) ? "text-ember" : ""}`} />
                  {t("optBrand")}
                </button>
                <button
                  type="button"
                  title={t("optVerticalHint")}
                  onClick={() => setPref({ vertical: !vertical })}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-colors ${
                    vertical ? "border-ember/60 bg-ember/10 text-fg" : "border-line text-mut hover:border-mut"
                  }`}
                >
                  <LuSmartphone className={`h-3.5 w-3.5 ${vertical ? "text-ember" : ""}`} />
                  {t("optVertical")}
                </button>
                <button
                  type="button"
                  title={t("optTrimUiHint")}
                  onClick={() => setPref({ trimUi: !trimUi })}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-colors ${
                    trimUi ? "border-ember/60 bg-ember/10 text-fg" : "border-line text-mut hover:border-mut"
                  }`}
                >
                  <LuEraser className={`h-3.5 w-3.5 ${trimUi ? "text-ember" : ""}`} />
                  {t("optTrimUi")}
                </button>
                <button
                  type="button"
                  title={t("optTitleCardHint")}
                  onClick={() => setPref({ titleCard: !titleCard })}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-colors ${
                    titleCard ? "border-ember/60 bg-ember/10 text-fg" : "border-line text-mut hover:border-mut"
                  }`}
                >
                  <LuType className={`h-3.5 w-3.5 ${titleCard ? "text-ember" : ""}`} />
                  {t("optTitleCard")}
                </button>
                <button
                  type="button"
                  title={t("optOpeningHookHint")}
                  onClick={() => setPref({ openingHook: !openingHook })}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-colors ${
                    openingHook ? "border-ember/60 bg-ember/10 text-fg" : "border-line text-mut hover:border-mut"
                  }`}
                >
                  <LuZap className={`h-3.5 w-3.5 ${openingHook ? "text-ember" : ""}`} />
                  {t("optOpeningHook")}
                </button>
                <button
                  type="button"
                  title={t("optJumpCutHint")}
                  onClick={() => setPref({ jumpCut: !jumpCut })}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-colors ${
                    jumpCut ? "border-ember/60 bg-ember/10 text-fg" : "border-line text-mut hover:border-mut"
                  }`}
                >
                  <LuFastForward className={`h-3.5 w-3.5 ${jumpCut ? "text-ember" : ""}`} />
                  {t("optJumpCut")}
                </button>
                <button
                  type="button"
                  title={t("optCleanFillersHint")}
                  onClick={() => setPref({ cleanFillers: !cleanFillers })}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-colors ${
                    cleanFillers ? "border-ember/60 bg-ember/10 text-fg" : "border-line text-mut hover:border-mut"
                  }`}
                >
                  <LuEraser className={`h-3.5 w-3.5 ${cleanFillers ? "text-ember" : ""}`} />
                  {t("optCleanFillers")}
                </button>
                <button
                  type="button"
                  title={t("optLoudnessHint")}
                  onClick={() => setPref({ normalizeLoudness: !normalizeLoudness })}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-colors ${
                    normalizeLoudness ? "border-ember/60 bg-ember/10 text-fg" : "border-line text-mut hover:border-mut"
                  }`}
                >
                  <LuVolume2 className={`h-3.5 w-3.5 ${normalizeLoudness ? "text-ember" : ""}`} />
                  {t("optLoudness")}
                </button>
                <button
                  type="button"
                  title={t("optDenoiseHint")}
                  onClick={() => setPref({ denoise: !denoise })}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-colors ${
                    denoise ? "border-ember/60 bg-ember/10 text-fg" : "border-line text-mut hover:border-mut"
                  }`}
                >
                  <LuAudioWaveform className={`h-3.5 w-3.5 ${denoise ? "text-ember" : ""}`} />
                  {t("optDenoise")}
                </button>
                <button
                  type="button"
                  title={t("optTranslateHint")}
                  onClick={() => setPref({ translate: !translate })}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-colors ${
                    translate ? "border-ember/60 bg-ember/10 text-fg" : "border-line text-mut hover:border-mut"
                  }`}
                >
                  <LuLanguages className={`h-3.5 w-3.5 ${translate ? "text-ember" : ""}`} />
                  {t(targetLang === "en" ? "optTranslateEn" : "optTranslateZh")}
                </button>
                <button
                  type="button"
                  title={t("optPublishHint")}
                  onClick={() => setPref({ publishCopy: !publishCopy })}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-colors ${
                    publishCopy ? "border-ember/60 bg-ember/10 text-fg" : "border-line text-mut hover:border-mut"
                  }`}
                >
                  <LuMegaphone className={`h-3.5 w-3.5 ${publishCopy ? "text-ember" : ""}`} />
                  {t("optPublish")}
                </button>
                <button
                  type="button"
                  title={t("optSrtHint")}
                  onClick={() => setPref({ subtitleFile: !subtitleFile })}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-colors ${
                    subtitleFile ? "border-ember/60 bg-ember/10 text-fg" : "border-line text-mut hover:border-mut"
                  }`}
                >
                  <LuFileText className={`h-3.5 w-3.5 ${subtitleFile ? "text-ember" : ""}`} />
                  {t("optSrt")}
                </button>
                <button
                  type="button"
                  title={t("optTimelineHint")}
                  onClick={() => setPref({ timeline: !timeline })}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-colors ${
                    timeline ? "border-ember/60 bg-ember/10 text-fg" : "border-line text-mut hover:border-mut"
                  }`}
                >
                  <LuFilm className={`h-3.5 w-3.5 ${timeline ? "text-ember" : ""}`} />
                  {t("optTimeline")}
                </button>
                <button
                  type="button"
                  title={t("optAigcHint")}
                  onClick={() => setPref({ aigcLabel: !aigcLabel })}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-colors ${
                    aigcLabel ? "border-ember/60 bg-ember/10 text-fg" : "border-line text-mut hover:border-mut"
                  }`}
                >
                  <LuBadgeCheck className={`h-3.5 w-3.5 ${aigcLabel ? "text-ember" : ""}`} />
                  {t("optAigc")}
                </button>
                <button
                  type="button"
                  title={t("captionStyleHint")}
                  onClick={() =>
                    setPref({ captionStyle: CAPTION_CYCLE[(CAPTION_CYCLE.indexOf(captionStyle) + 1) % CAPTION_CYCLE.length] })
                  }
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-colors ${
                    captionStyle !== "none" ? "border-ember/60 bg-ember/10 text-fg" : "border-line text-mut hover:border-mut"
                  }`}
                >
                  <LuCaptions className={`h-3.5 w-3.5 ${captionStyle !== "none" ? "text-ember" : ""}`} />
                  {t(CAPTION_KEY[captionStyle])}
                </button>
              </div>
              <button
                type="button"
                disabled={selected.size === 0}
                onClick={() =>
                  onExport(candidates.filter((c) => selected.has(c.id)), { vertical, captionStyle, jumpCut, cleanFillers, trimUi, titleCard, openingHook, normalizeLoudness, denoise, brand: activeBrandStyle(brandState), translate: translate ? { targetLang, llm: config } : undefined, publishCopy: publishCopy ? { llm: config } : undefined, subtitleFile, timeline, aigcLabel })
                }
                className="btn-flame inline-flex items-center gap-1.5 rounded-lg px-6 py-2.5 text-[14px] font-bold text-white disabled:opacity-40"
              >
                <LuScissors className="h-4 w-4" />
                {t("exportSelected")}
              </button>
            </div>
          )}

          {/* ---- 品牌样式模板 ---- */}
          {showBrand && <BrandStyleModal onClose={() => setShowBrand(false)} />}

          {/* ---- 审阅台:视频预览 + 波形时间轴,拖拽定切点 ---- */}
          {(() => {
            const reviewing = reviewId !== null ? candidates.find((c) => c.id === reviewId) : undefined;
            if (!reviewing) return null;
            return (
              <ClipReviewModal
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
