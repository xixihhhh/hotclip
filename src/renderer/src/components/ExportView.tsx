/**
 * Wizard step 3: cut the selected highlights into files.
 * Auto-starts on mount; shows per-clip progress, then the exported file list
 * with reveal-in-folder actions.
 */
import { useEffect, useRef, useState } from "react";
import { LuScissors, LuCircleCheck, LuFolderOpen, LuArrowLeft, LuRotateCcw, LuFilm, LuCircleStop } from "react-icons/lu";
import { useT } from "../i18n/store";
import { getApi, isElectron } from "../api/provider";
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
  const started = useRef(false);

  // 可重入的导出启动:失败/取消后「重试」直接再跑一轮,不再 reload 整个应用
  // (reload 会把整个会话状态一起炸掉——工作台时代候选还在 store 里,不能陪葬)
  const runExport = useRef(() => {});
  runExport.current = (): void => {
    setError(null);
    setResults(null);
    setProgress(null);
    const api = getApi();
    const unsubscribe = api.onExportProgress(setProgress);
    api
      // the transcript ships along only when captions need word timestamps
      .exportClips(filePath, clips, {
        ...options,
        transcript:
          options.captionStyle !== "none" || options.jumpCut || options.cleanFillers || options.cutRetakes || Boolean(options.translate)
            ? transcript
            : undefined,
      })
      .then(setResults)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(unsubscribe);
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    runExport.current();
  }, []);

  const currentClip = progress ? clips.find((c) => c.id === progress.clipId) : null;
  // 总进度 = 已完成条数 + 当前条的实时编码进度(ffmpeg 回报;无 fraction 时按半条估)
  const doneFrac = progress
    ? progress.stage === "done"
      ? progress.current
      : progress.current - 1 + (progress.fraction ?? 0.5)
    : 0;
  const pct = progress ? Math.round((doneFrac / progress.total) * 100) : 0;

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
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => getApi().cancelExport()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3.5 py-1.5 text-[12.5px] text-mut transition-colors hover:border-red-400/60 hover:text-red-400"
              >
                <LuCircleStop className="h-3.5 w-3.5" />
                {t("cancel")}
              </button>
            </div>
          </div>
        </>
      )}

      {/* error / cancelled */}
      {error && (
        <div className="card mt-2 w-full rounded-2xl p-6 text-center">
          <p className={`text-sm break-all ${/cancel/i.test(error) ? "text-mut" : "text-red-400"}`}>
            {/cancel/i.test(error) ? t("cancelled") : t("failed", { msg: error })}
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
