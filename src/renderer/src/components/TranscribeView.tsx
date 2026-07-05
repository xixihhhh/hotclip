/**
 * Wizard step 2: engine picker → transcription progress → sentence transcript.
 * Transcript quality gates everything downstream, so the engine choice is an
 * explicit first-class step (speed vs accuracy vs cloud), remembered per user.
 */
import { useEffect, useRef, useState } from "react";
import {
  LuAudioLines,
  LuArrowLeft,
  LuCircleCheck,
  LuDownload,
  LuFlame,
  LuShieldCheck,
  LuGauge,
  LuTarget,
  LuCloudUpload,
} from "react-icons/lu";
import { useT } from "../i18n/store";
import { getApi } from "../api/provider";
import { useAsrStore } from "../stores/asr-store";
import type { Transcript, TranscribeProgressEvent, AsrEngineInfo } from "../../../shared/api-types";

function formatClock(totalSeconds: number): string {
  const s = Math.floor(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const STAGE_KEY: Record<TranscribeProgressEvent["stage"], string> = {
  preparing: "stagePreparing",
  "downloading-model": "stageDownloadingModel",
  decoding: "stageDecoding",
  transcribing: "stageTranscribing",
  finalizing: "stageFinalizing",
};

/** catalog id → i18n name/desc keys (unknown ids fall back to raw id). */
const ENGINE_TEXT: Record<string, { name: string; desc: string }> = {
  sensevoice: { name: "engineSensevoiceName", desc: "engineSensevoiceDesc" },
  paraformer: { name: "engineParaformerName", desc: "engineParaformerDesc" },
  fireredasr: { name: "engineFireredName", desc: "engineFireredDesc" },
};

/** Transcript.engine ids reported by backends → catalog id. */
function catalogIdOf(engineReported: string): string {
  return engineReported.replace(/-local$/, "");
}

export function TranscribeView({
  filePath,
  onBack,
  onDone,
  onFindHighlights,
  cached,
}: {
  filePath: string;
  onBack: () => void;
  onDone?: (t: Transcript) => void;
  onFindHighlights?: () => void;
  /** Already-produced transcript (returning from a later phase) — skip work. */
  cached?: Transcript | null;
}): React.JSX.Element {
  const t = useT("transcribe");
  const { engineId, setEngineId } = useAsrStore();
  const [engines, setEngines] = useState<AsrEngineInfo[] | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<TranscribeProgressEvent>({ fraction: 0, stage: "preparing" });
  const [transcript, setTranscript] = useState<Transcript | null>(cached ?? null);
  const [error, setError] = useState<string | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (cached) return;
    getApi()
      .listAsrEngines()
      .then(setEngines)
      .catch(() => setEngines([]));
    return () => unsubRef.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = (): void => {
    setRunning(true);
    setError(null);
    setProgress({ fraction: 0, stage: "preparing" });
    const api = getApi();
    unsubRef.current = api.onTranscribeProgress(setProgress);
    api
      .transcribeMedia(filePath, engineId)
      .then((result) => {
        setTranscript(result);
        onDone?.(result);
      })
      .catch(() => setError(t("failed")))
      .finally(() => {
        unsubRef.current?.();
        unsubRef.current = null;
        setRunning(false);
      });
  };

  const pct = Math.round(progress.fraction * 100);
  const isDownload = progress.stage === "downloading-model";
  const downloadPct =
    isDownload && progress.totalBytes ? Math.round(((progress.downloadedBytes ?? 0) / progress.totalBytes) * 100) : 0;
  const barPct = isDownload ? downloadPct : pct;

  const usedEngine = transcript ? ENGINE_TEXT[catalogIdOf(transcript.engine)] : null;

  return (
    <div className="rise-in flex w-full max-w-2xl flex-col items-center">
      {/* ---- engine picker ---- */}
      {!transcript && !running && !error && (
        <>
          <h1 className="text-center text-3xl font-extrabold tracking-tight">{t("enginePickTitle")}</h1>
          <p className="mt-3 max-w-lg text-center text-[14px] text-mut">{t("enginePickDesc")}</p>

          <div className="mt-8 grid w-full gap-3">
            {(engines ?? []).map((e) => {
              const text = ENGINE_TEXT[e.id];
              const active = engineId === e.id;
              return (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => setEngineId(e.id)}
                  className={`card card-hover rounded-2xl border p-5 text-left transition-colors ${
                    active ? "!border-ember/60 bg-ember/5" : ""
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[15px] font-bold">{text ? t(text.name) : e.id}</span>
                    <span
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
                        active ? "flame-gradient border-transparent" : "border-line"
                      }`}
                    >
                      {active && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                    </span>
                  </div>
                  {text && <p className="mt-1 text-[12.5px] text-mut">{t(text.desc)}</p>}
                  <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[10.5px]">
                    <span className="chip flex items-center gap-1 rounded-md px-2 py-0.5">
                      {e.uploads ? <LuCloudUpload className="h-3 w-3" /> : <LuShieldCheck className="h-3 w-3 text-emerald-400" />}
                      {e.uploads ? t("badgeNeedsUpload") : t("badgeLocalPrivate")}
                    </span>
                    <span className="chip flex items-center gap-1 rounded-md px-2 py-0.5">
                      <LuGauge className="h-3 w-3" />
                      {"●".repeat(e.speed)}{"○".repeat(3 - e.speed)}
                    </span>
                    <span className="chip flex items-center gap-1 rounded-md px-2 py-0.5">
                      <LuTarget className="h-3 w-3" />
                      {"●".repeat(e.accuracy)}{"○".repeat(3 - e.accuracy)}
                    </span>
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

          <div className="mt-6 flex items-center gap-3">
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line px-4 py-2.5 text-sm text-mut transition-colors hover:border-mut hover:text-fg"
            >
              <LuArrowLeft className="h-4 w-4" />
              {t("back")}
            </button>
            <button
              type="button"
              onClick={start}
              className="btn-flame rounded-xl px-9 py-3 text-[14px] font-bold text-white"
            >
              {t("engineStart")}
            </button>
          </div>
        </>
      )}

      {/* ---- progress ---- */}
      {running && !transcript && !error && (
        <>
          <h1 className="text-center text-3xl font-extrabold tracking-tight">{t("title")}</h1>
          <p className="mt-3 max-w-lg text-center text-[14px] text-mut">{t("desc")}</p>

          <div className="card mt-9 w-full rounded-2xl p-6">
            <div className="flex items-center gap-2 text-[14px] font-semibold">
              {isDownload ? (
                <LuDownload className="h-4 w-4 text-ember" />
              ) : (
                <LuAudioLines className="h-4 w-4 text-ember" />
              )}
              <span>{t(STAGE_KEY[progress.stage])}</span>
              <span className="ml-auto text-[13px] font-bold text-mut">{barPct}%</span>
            </div>
            <div className="mt-4 h-2 overflow-hidden rounded-full bg-panel-2">
              <div
                className="flame-gradient h-full rounded-full transition-[width] duration-300"
                style={{ width: `${Math.max(2, barPct)}%` }}
              />
            </div>
            {isDownload && <p className="mt-3 text-xs text-mut">{t("downloadHint")}</p>}
          </div>
        </>
      )}

      {/* ---- error ---- */}
      {error && (
        <div className="card mt-6 w-full rounded-2xl p-6 text-center">
          <p className="text-sm text-red-400">{error}</p>
          <div className="mt-4 flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line px-4 py-2 text-sm text-mut transition-colors hover:border-mut hover:text-fg"
            >
              <LuArrowLeft className="h-4 w-4" />
              {t("back")}
            </button>
            <button
              type="button"
              onClick={() => setError(null)}
              className="btn-flame rounded-lg px-5 py-2 text-sm font-bold text-white"
            >
              {t("engineStart")}
            </button>
          </div>
        </div>
      )}

      {/* ---- result ---- */}
      {transcript && (
        <section className="w-full">
          <div className="flex items-end justify-between">
            <div>
              <h1 className="flex items-center gap-2 text-2xl font-extrabold tracking-tight">
                <LuCircleCheck className="h-6 w-6 text-emerald-400" />
                {t("resultTitle")}
              </h1>
              <p className="mt-1.5 text-[13px] text-mut">
                {t("resultCount", { n: transcript.segments.length, lang: transcript.language })} ·{" "}
                {usedEngine ? t(usedEngine.name) : t("engineLocal")}
              </p>
            </div>
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={onBack}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3.5 py-2 text-xs text-mut transition-colors hover:border-mut hover:text-fg"
              >
                <LuArrowLeft className="h-3.5 w-3.5" />
                {t("back")}
              </button>
              {onFindHighlights && (
                <button
                  type="button"
                  onClick={onFindHighlights}
                  className="btn-flame inline-flex items-center gap-1.5 rounded-lg px-5 py-2 text-[13px] font-bold text-white"
                >
                  <LuFlame className="h-4 w-4" />
                  {t("findHighlights")}
                </button>
              )}
            </div>
          </div>

          <div className="card mt-5 max-h-[46vh] overflow-y-auto rounded-2xl p-2">
            {transcript.segments.map((seg) => (
              <div
                key={seg.id}
                className="flex items-baseline gap-4 rounded-xl px-4 py-2.5 transition-colors hover:bg-panel-2"
              >
                <span className="shrink-0 font-mono text-[11px] text-ember/90">{formatClock(seg.startSec)}</span>
                <p className="text-[14px] leading-relaxed">{seg.text}</p>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
