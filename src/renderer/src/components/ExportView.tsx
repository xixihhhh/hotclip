/**
 * Wizard step 3: cut the selected highlights into files.
 * Auto-starts on mount; shows per-clip progress, then the exported file list
 * with reveal-in-folder actions.
 */
import { useEffect, useRef, useState } from "react";
import { LuScissors, LuCircleCheck, LuFolderOpen, LuArrowLeft, LuRotateCcw, LuFilm, LuCircleStop } from "react-icons/lu";
import { useT } from "../i18n/store";
import { getApi, isElectron } from "../api/provider";
import { exportProgressPercent } from "../../../shared/export-progress";
import { exportNeedsTranscript } from "../../../shared/export-transcript";
import type {
  HighlightCandidate,
  ExportedClip,
  ExportProgressEvent,
  RenderToggles,
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
  options: RenderToggles;
  transcript: Transcript;
  onBack: () => void;
  onRestart: () => void;
}): React.JSX.Element {
  const t = useT("exportPage");
  const [progress, setProgress] = useState<ExportProgressEvent | null>(null);
  const [results, setResults] = useState<ExportedClip[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const running = useRef(false);
  const requestId = useRef(0);
  const unsubscribeProgress = useRef(() => {});

  // 可重入的导出启动:失败/取消后「重试」直接再跑一轮,不再 reload 整个应用
  // (reload 会把整个会话状态一起炸掉——工作台时代候选还在 store 里,不能陪葬)
  const runExport = useRef(() => {});
  runExport.current = (): void => {
    if (running.current) return;
    running.current = true;
    const id = ++requestId.current;
    setCancelling(false);
    setError(null);
    setResults(null);
    setProgress(null);
    const api = getApi();
    const unsubscribe = api.onExportProgress((value) => {
      if (id === requestId.current) setProgress(value);
    });
    unsubscribeProgress.current = unsubscribe;
    api
      // Sidecars and speech edits need the same words as burned captions.
      .exportClips(filePath, clips, {
        ...options,
        transcript: exportNeedsTranscript(options) ? transcript : undefined,
      })
      .then((value) => { if (id === requestId.current) setResults(value); })
      .catch((e) => { if (id === requestId.current) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => {
        unsubscribe();
        if (id === requestId.current) { running.current = false; setCancelling(false); }
      });
  };

  useEffect(() => {
    // StrictMode's first setup is discarded before this timer can launch work.
    const timer = setTimeout(() => runExport.current(), 0);
    return () => {
      clearTimeout(timer);
      requestId.current++;
      unsubscribeProgress.current();
      if (running.current) getApi().cancelExport();
      running.current = false;
    };
  }, []);

  const currentClip = progress ? clips.find((c) => c.id === progress.clipId) : null;
  const pct = exportProgressPercent(progress);
  const stageLabel = cancelling ? t("cancelling")
    : progress?.stage === "preparing" ? t(`preparing_${progress.preparation ?? "media"}`)
    : progress?.stage === "finalizing" ? t("finalizing")
    : progress ? t("cuttingClip", { current: progress.current, total: progress.total, title: currentClip?.title ?? t("variantClip") })
    : t("preparing_media");

  return (
    <div className="rise-in flex w-full max-w-2xl flex-col items-center">
      {/* cutting */}
      {!results && !error && (
        <>
          <h1 className="text-center text-3xl font-extrabold tracking-tight">{t("title")}</h1>
          <div className="card mt-8 w-full rounded-2xl p-6">
            <div className="flex items-center gap-2 text-[14px] font-semibold">
              <LuScissors className="h-4 w-4 animate-pulse text-ember" />
              <span className="min-w-0" role="status">{stageLabel}</span>
              <span className="ml-auto shrink-0 text-[13px] font-bold text-mut">{pct}%</span>
            </div>
            <div className="mt-4 h-2 overflow-hidden rounded-full bg-panel-2" role="progressbar" aria-label={t("title")} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <div
                className="flame-gradient h-full rounded-full transition-[width] duration-300"
                style={{ width: `${Math.max(2, pct)}%` }}
              />
            </div>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                disabled={cancelling}
                onClick={() => { setCancelling(true); getApi().cancelExport(); }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3.5 py-1.5 text-[12.5px] text-mut transition-colors hover:border-red-400/60 hover:text-red-400"
              >
                <LuCircleStop className="h-3.5 w-3.5" />
                {cancelling ? t("cancelling") : t("cancel")}
              </button>
            </div>
          </div>
        </>
      )}

      {/* error / cancelled */}
      {error && (
        <div className="card mt-2 w-full rounded-2xl p-6 text-center">
          <p className={`text-sm break-all ${/cancel/i.test(error) ? "text-mut" : "text-red-400"}`}>
            {/cancel/i.test(error) ? t("cancelled") : /export:busy/.test(error) ? t("busy") : t("failed", { msg: error })}
          </p>
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
              onClick={() => runExport.current()}
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
            <p className="mx-auto mt-1.5 max-w-md text-[12px] text-mut/80">{t("doneMeta")}</p>
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
                  <div className="flex min-w-0 items-center gap-2">
                    <p className="min-w-0 truncate text-[14px] font-semibold">{clip.title}</p>
                    {clip.colorConverted && (
                      <span className="chip shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap text-cyan-300">
                        {t("hdrConverted")}
                      </span>
                    )}
                    {clip.colorConversionSkipped && (
                      <span className="chip shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap text-amber-300">
                        {t("hdrSkipped")}
                      </span>
                    )}
                    {clip.colorInspectionFailed && (
                      <span className="chip shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap text-amber-300">
                        {t("colorInspectionFailed")}
                      </span>
                    )}
                    {clip.audioEnhancement === "learned" && (
                      <span className="chip shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap text-emerald-300">
                        {t("audioLearned")}
                      </span>
                    )}
                    {clip.audioEnhancement === "fallback" && (
                      <span className="chip shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap text-amber-300">
                        {t("audioFallback")}
                      </span>
                    )}
                    {clip.audioEnhancement === "skipped" && (
                      <span className="chip shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap text-red-300">
                        {t("audioSkipped")}
                      </span>
                    )}
                  </div>
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
