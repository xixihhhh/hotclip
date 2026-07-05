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
} from "react-icons/lu";
import { useT } from "../i18n/store";
import { getApi, isElectron } from "../api/provider";
import { useLlmStore, isLlmReady, LLM_PRESETS } from "../stores/llm-store";
import type { Transcript, HighlightCandidate, ExportOptions, CaptionStyleChoice } from "../../../shared/api-types";

/** Click-to-cycle order for the caption style chip. */
const CAPTION_CYCLE: CaptionStyleChoice[] = ["karaoke", "keyword", "pop", "none"];
const CAPTION_KEY: Record<CaptionStyleChoice, string> = {
  none: "captionNone",
  karaoke: "captionKaraoke",
  keyword: "captionKeyword",
  pop: "captionPop",
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
  onBack,
  onExport,
}: {
  transcript: Transcript;
  onBack: () => void;
  onExport?: (clips: HighlightCandidate[], options: Pick<ExportOptions, "vertical" | "captionStyle">) => void;
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
  // Vertical + karaoke ON by default — publish-ready clips out of the box.
  const [vertical, setVertical] = useState(true);
  const [captionStyle, setCaptionStyle] = useState<CaptionStyleChoice>("karaoke");
  const startedRef = useRef(false);

  const run = useCallback(async (): Promise<void> => {
    setDetecting(true);
    setError(null);
    try {
      const result = await getApi().detectHighlights(transcript, config);
      setCandidates(result);
      setSelected(new Set(result.map((c) => c.id))); // all selected by default
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDetecting(false);
    }
  }, [transcript, config]);

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
      void run();
    }
  }, [showGate, run]);

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
            <button type="button" onClick={run} className="btn-flame rounded-lg px-5 py-2 text-sm font-bold text-white">
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
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3.5 py-2 text-xs text-mut transition-colors hover:border-mut hover:text-fg"
            >
              <LuArrowLeft className="h-3.5 w-3.5" />
              {t("retry")}
            </button>
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

                <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-dashed border-line pt-3.5 text-[11px] text-mut">
                  <span className="chip flex items-center gap-1 rounded-md px-2 py-0.5 font-mono">
                    <LuClock3 className="h-3 w-3" />
                    {formatClock(c.startSec)} → {formatClock(c.endSec)}
                  </span>
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
                onClick={() => onExport(candidates.filter((c) => selected.has(c.id)), { vertical, captionStyle })}
                className="btn-flame inline-flex items-center gap-1.5 rounded-lg px-6 py-2.5 text-[14px] font-bold text-white disabled:opacity-40"
              >
                <LuScissors className="h-4 w-4" />
                {t("exportSelected")}
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
