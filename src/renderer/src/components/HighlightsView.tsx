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
  LuChevronLeft,
  LuChevronRight,
  LuPlay,
} from "react-icons/lu";
import { useT } from "../i18n/store";
import { getApi, isElectron } from "../api/provider";
import { useLlmStore, isLlmReady, LLM_PRESETS } from "../stores/llm-store";
import { adjustClipBoundary } from "../../../shared/boundary";
import { ClipReviewModal } from "./ClipReviewModal";
import type { Transcript, HighlightCandidate, ExportOptions, CaptionStyleChoice } from "../../../shared/api-types";

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
  onExport?: (clips: HighlightCandidate[], options: Pick<ExportOptions, "vertical" | "captionStyle" | "jumpCut" | "cleanFillers" | "trimUi" | "titleCard" | "openingHook" | "normalizeLoudness">) => void;
  /** Lift the diarization-labeled transcript up so export colors captions by speaker. */
  onTranscriptLabeled?: (t: Transcript) => void;
  /** 托管 mode: export every candidate with default render options as soon as they land. */
  auto?: boolean;
}): React.JSX.Element {
  const t = useT("highlights");
  const { config, setConfig } = useLlmStore();
  // browser preview (mock) needs no key; Electron needs a real endpoint
  const gateOpen = !isElectron() || isLlmReady(config);
  const [showGate, setShowGate] = useState(!gateOpen);
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<HighlightCandidate[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // Vertical + karaoke + jump-cut ON by default — publish-ready clips out of the box.
  const [vertical, setVertical] = useState(true);
  const [captionStyle, setCaptionStyle] = useState<CaptionStyleChoice>("karaoke");
  const [jumpCut, setJumpCut] = useState(true);
  const [cleanFillers, setCleanFillers] = useState(true);
  const [trimUi, setTrimUi] = useState(true);
  const [diarize, setDiarize] = useState(false);
  const [titleCard, setTitleCard] = useState(true);
  const [openingHook, setOpeningHook] = useState(true);
  const [normalizeLoudness, setNormalizeLoudness] = useState(true);
  /** 审阅台当前打开的候选 id;null = 关闭。 */
  const [reviewId, setReviewId] = useState<number | null>(null);
  const startedRef = useRef(false);

  const run = useCallback(async (useDiarize: boolean): Promise<void> => {
    setDetecting(true);
    setError(null);
    try {
      const result = await getApi().detectHighlights(transcript, config, filePath, useDiarize);
      setCandidates(result.candidates);
      // reviewer-approved clips are pre-selected; flagged ones start unchecked
      setSelected(new Set(result.candidates.filter((c) => c.recommended).map((c) => c.id)));
      // Lift the speaker-labeled transcript so export can color captions by speaker.
      if (result.transcript) onTranscriptLabeled?.(result.transcript);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDetecting(false);
    }
  }, [transcript, config, filePath, onTranscriptLabeled]);

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
      onExport(publishable, { vertical: true, captionStyle: "karaoke", jumpCut: true, cleanFillers: true, trimUi: true, titleCard: true, openingHook: true, normalizeLoudness: true });
    }
  }, [auto, candidates, onExport]);

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
            </div>
            <div className="flex items-center gap-2">
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
                    <h3 className="text-[16px] leading-snug font-bold">{c.title}</h3>
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
                  title={t("optVerticalHint")}
                  onClick={() => setVertical(!vertical)}
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
                  onClick={() => setTrimUi(!trimUi)}
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
                  onClick={() => setTitleCard(!titleCard)}
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
                  onClick={() => setOpeningHook(!openingHook)}
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
                  onClick={() => setJumpCut(!jumpCut)}
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
                  onClick={() => setCleanFillers(!cleanFillers)}
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
                  onClick={() => setNormalizeLoudness(!normalizeLoudness)}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-colors ${
                    normalizeLoudness ? "border-ember/60 bg-ember/10 text-fg" : "border-line text-mut hover:border-mut"
                  }`}
                >
                  <LuVolume2 className={`h-3.5 w-3.5 ${normalizeLoudness ? "text-ember" : ""}`} />
                  {t("optLoudness")}
                </button>
                <button
                  type="button"
                  title={t("captionStyleHint")}
                  onClick={() =>
                    setCaptionStyle(CAPTION_CYCLE[(CAPTION_CYCLE.indexOf(captionStyle) + 1) % CAPTION_CYCLE.length])
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
                  onExport(candidates.filter((c) => selected.has(c.id)), { vertical, captionStyle, jumpCut, cleanFillers, trimUi, titleCard, openingHook, normalizeLoudness })
                }
                className="btn-flame inline-flex items-center gap-1.5 rounded-lg px-6 py-2.5 text-[14px] font-bold text-white disabled:opacity-40"
              >
                <LuScissors className="h-4 w-4" />
                {t("exportSelected")}
              </button>
            </div>
          )}

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
