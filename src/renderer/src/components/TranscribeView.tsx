/**
 * Wizard step 2: transcription progress + the resulting sentence transcript.
 * Kicks off transcribeMedia on mount; renders staged progress (model download
 * with byte counter → decoding → per-fraction transcribing) then the list.
 */
import { useEffect, useRef, useState } from "react";
import { LuAudioLines, LuArrowLeft, LuCircleCheck, LuDownload } from "react-icons/lu";
import { useT } from "../i18n/store";
import { getApi } from "../api/provider";
import type { Transcript, TranscribeProgressEvent } from "../../../shared/api-types";

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

export function TranscribeView({
  filePath,
  onBack,
  onDone,
}: {
  filePath: string;
  onBack: () => void;
  onDone?: (t: Transcript) => void;
}): React.JSX.Element {
  const t = useT("transcribe");
  const [progress, setProgress] = useState<TranscribeProgressEvent>({ fraction: 0, stage: "preparing" });
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    // StrictMode double-mount guard: one transcription per view instance
    if (started.current) return;
    started.current = true;
    const api = getApi();
    const unsubscribe = api.onTranscribeProgress(setProgress);
    api
      .transcribeMedia(filePath)
      .then((result) => {
        setTranscript(result);
        onDone?.(result);
      })
      .catch(() => setError(t("failed")))
      .finally(unsubscribe);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  const pct = Math.round(progress.fraction * 100);
  const isDownload = progress.stage === "downloading-model";
  const downloadPct =
    isDownload && progress.totalBytes ? Math.round(((progress.downloadedBytes ?? 0) / progress.totalBytes) * 100) : 0;
  const barPct = isDownload ? downloadPct : pct;

  return (
    <div className="rise-in flex w-full max-w-2xl flex-col items-center">
      {!transcript && !error && (
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

      {error && (
        <div className="card mt-6 w-full rounded-2xl p-6 text-center">
          <p className="text-sm text-red-400">{error}</p>
          <button
            type="button"
            onClick={onBack}
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-line px-4 py-2 text-sm text-mut transition-colors hover:border-mut hover:text-fg"
          >
            <LuArrowLeft className="h-4 w-4" />
            {t("back")}
          </button>
        </div>
      )}

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
                {t("engineLocal")}
              </p>
            </div>
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3.5 py-2 text-xs text-mut transition-colors hover:border-mut hover:text-fg"
            >
              <LuArrowLeft className="h-3.5 w-3.5" />
              {t("back")}
            </button>
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
