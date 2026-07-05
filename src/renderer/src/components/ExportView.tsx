/**
 * Wizard step 3: cut the selected highlights into files.
 * Auto-starts on mount; shows per-clip progress, then the exported file list
 * with reveal-in-folder actions.
 */
import { useEffect, useRef, useState } from "react";
import { LuScissors, LuCircleCheck, LuFolderOpen, LuArrowLeft, LuRotateCcw, LuFilm } from "react-icons/lu";
import { useT } from "../i18n/store";
import { getApi, isElectron } from "../api/provider";
import type {
  HighlightCandidate,
  ExportedClip,
  ExportProgressEvent,
  ExportOptions,
  Transcript,
} from "../../../shared/api-types";

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

export function ExportView({
  filePath,
  clips,
  options,
  transcript,
  onBack,
  onRestart,
}: {
  filePath: string;
  clips: HighlightCandidate[];
  options: Pick<ExportOptions, "vertical" | "captionStyle">;
  transcript: Transcript;
  onBack: () => void;
  onRestart: () => void;
}): React.JSX.Element {
  const t = useT("exportPage");
  const [progress, setProgress] = useState<ExportProgressEvent | null>(null);
  const [results, setResults] = useState<ExportedClip[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const api = getApi();
    const unsubscribe = api.onExportProgress(setProgress);
    api
      // the transcript ships along only when captions need word timestamps
      .exportClips(filePath, clips, {
        ...options,
        transcript: options.captionStyle !== "none" ? transcript : undefined,
      })
      .then(setResults)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(unsubscribe);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentClip = progress ? clips.find((c) => c.id === progress.clipId) : null;
  const pct = progress ? Math.round(((progress.current - (progress.stage === "cutting" ? 0.5 : 0)) / progress.total) * 100) : 0;

  return (
    <div className="rise-in flex w-full max-w-2xl flex-col items-center">
      {/* cutting */}
      {!results && !error && (
        <>
          <h1 className="text-center text-3xl font-extrabold tracking-tight">{t("title")}</h1>
          <div className="card mt-8 w-full rounded-2xl p-6">
            <div className="flex items-center gap-2 text-[14px] font-semibold">
              <LuScissors className="h-4 w-4 animate-pulse text-ember" />
              <span className="truncate">
                {progress && currentClip
                  ? t("cuttingClip", { current: progress.current, total: progress.total, title: currentClip.title })
                  : "…"}
              </span>
              <span className="ml-auto shrink-0 text-[13px] font-bold text-mut">{pct}%</span>
            </div>
            <div className="mt-4 h-2 overflow-hidden rounded-full bg-panel-2">
              <div
                className="flame-gradient h-full rounded-full transition-[width] duration-300"
                style={{ width: `${Math.max(2, pct)}%` }}
              />
            </div>
          </div>
        </>
      )}

      {/* error */}
      {error && (
        <div className="card mt-2 w-full rounded-2xl p-6 text-center">
          <p className="text-sm break-all text-red-400">{t("failed", { msg: error })}</p>
          <div className="mt-4 flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line px-4 py-2 text-sm text-mut transition-colors hover:border-mut hover:text-fg"
            >
              <LuArrowLeft className="h-4 w-4" />
              {t("backToHighlights")}
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="btn-flame rounded-lg px-5 py-2 text-sm font-bold text-white"
            >
              {t("retry")}
            </button>
          </div>
        </div>
      )}

      {/* done */}
      {results && (
        <section className="w-full">
          <div className="text-center">
            <LuCircleCheck className="mx-auto h-10 w-10 text-emerald-400" />
            <h1 className="mt-3 text-3xl font-extrabold tracking-tight">{t("doneTitle")}</h1>
            <p className="mt-2 text-[14px] text-mut">{t("doneDesc", { n: results.length })}</p>
          </div>

          <div className="card mt-7 rounded-2xl p-2">
            {results.map((clip) => (
              <div
                key={clip.id}
                className="flex items-center gap-3.5 rounded-xl px-4 py-3 transition-colors hover:bg-panel-2"
              >
                <div className="icon-tile flex h-10 w-10 shrink-0 items-center justify-center rounded-lg">
                  <LuFilm className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-semibold">{clip.title}</p>
                  <p className="mt-0.5 truncate text-[11px] text-mut">
                    {Math.round(clip.durationSec)}s · {formatSize(clip.sizeBytes)} · {clip.path}
                  </p>
                </div>
                {isElectron() && (
                  <button
                    type="button"
                    onClick={() => getApi().revealClip(clip.path)}
                    title={t("reveal")}
                    className="shrink-0 rounded-lg border border-line p-2 text-mut transition-colors hover:border-mut hover:text-fg"
                  >
                    <LuFolderOpen className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
          </div>

          <div className="mt-6 flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line px-4 py-2 text-sm text-mut transition-colors hover:border-mut hover:text-fg"
            >
              <LuArrowLeft className="h-4 w-4" />
              {t("backToHighlights")}
            </button>
            <button
              type="button"
              onClick={onRestart}
              className="btn-flame inline-flex items-center gap-1.5 rounded-lg px-5 py-2.5 text-sm font-bold text-white"
            >
              <LuRotateCcw className="h-4 w-4" />
              {t("makeAnother")}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
