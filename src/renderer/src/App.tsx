/**
 * App 外壳:顶栏(项目名 + 管线状态 + 一键托管 + 设置)+ 视图分派。
 * 三步向导退役——没素材时是导入页,有素材即进「工作台」;设置中心全屏
 * 视图任何时刻可达。会话状态全部在 session store,视图切换不丢结果。
 * Electron(IPC)与纯浏览器(mock)双跑,后者是设计预览通路。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  LuCheck,
  LuCircleArrowUp,
  LuFileVideo,
  LuFolderSearch,
  LuFolderOpen,
  LuLanguages,
  LuLink,
  LuLoaderCircle,
  LuSettings,
  LuShieldCheck,
  LuWandSparkles,
  LuX,
} from "react-icons/lu";
import { useT, useLocaleStore } from "./i18n/store";
import { LOCALE_LIST, REGISTRY } from "./i18n/messages";
import { getApi } from "./api/provider";
import { initialSessionCheckpoint, sessionCheckpointFromState, useSession, type ProbedFile } from "./stores/session-store";
import { LogoMark, LogoWordmark } from "./components/Logo";
import { Workbench } from "./components/Workbench";
import { SettingsView } from "./components/SettingsView";
import { WatchFolderModal } from "./components/WatchFolderModal";
import { ProjectLibraryModal } from "./components/ProjectLibraryModal";
import type { ProjectSummary, UpdateInfo, UrlImportProgressEvent } from "../../shared/api-types";
import "./app.css";

function displayName(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.[^.]+$/, "");
}

function formatDuration(totalSeconds: number): string {
  const s = Math.floor(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const mm = String(m).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatTransfer(bytes?: number): string {
  if (!bytes || bytes < 1) return "";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

const FILE_CHIPS = ["MP4", "MKV", "MOV", "FLV", "MP3"];

/** 管线状态 chip:✓ 完成 / ● 进行中 / 空心 未开始。 */
function PipeChip({ label, state, extra }: { label: string; state: "done" | "busy" | "idle"; extra?: string }): React.JSX.Element {
  return (
    <span
      className={`flex h-6.5 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] whitespace-nowrap ${
        state === "busy" ? "border-ember/50 bg-ember/10 text-ember" : "border-line bg-white/3 text-mut"
      }`}
    >
      {state === "done" ? (
        <LuCheck className="h-3 w-3 text-emerald-400" />
      ) : state === "busy" ? (
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ember" />
      ) : (
        <span className="h-1.5 w-1.5 rounded-full border border-mut/50" />
      )}
      {label}
      {extra && <span className="font-mono text-[10px] tabular-nums opacity-80">{extra}</span>}
    </span>
  );
}

/** 导入页:工作区的空态——拖放区 + 录播监听入口,营销话术退场。 */
function ImportStage({ onImportFile }: { onImportFile: (file: ProbedFile) => Promise<void> }): React.JSX.Element {
  const t = useT("home");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showWatch, setShowWatch] = useState(false);
  const [url, setUrl] = useState("");
  const [urlBusy, setUrlBusy] = useState(false);
  const [urlProgress, setUrlProgress] = useState<UrlImportProgressEvent | null>(null);

  useEffect(() => getApi().onUrlImportProgress(setUrlProgress), []);

  const probePath = useCallback(
    async (path: string): Promise<void> => {
      setBusy(true);
      setError(null);
      let file: ProbedFile;
      try {
        const info = await getApi().probeMedia(path);
        file = { path, ...info };
      } catch {
        setError(t("probeFailed"));
        setBusy(false);
        return;
      }
      try {
        await onImportFile(file);
      } catch {
        setError(t("projectCreateFailed"));
      } finally {
        setBusy(false);
      }
    },
    [onImportFile, t]
  );

  const pickFile = useCallback(async (): Promise<void> => {
    setError(null);
    const path = await getApi().selectMedia();
    if (!path) return;
    await probePath(path);
  }, [probePath]);

  const importUrl = useCallback(async (): Promise<void> => {
    if (!url.trim() || urlBusy) return;
    setError(null);
    setUrlBusy(true);
    setUrlProgress({ stage: "resolving" });
    try {
      const result = await getApi().importMediaUrl(url);
      await probePath(result.filePath);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!/AbortError|Aborted/i.test(message)) setError(t("urlFailed"));
    } finally {
      setUrlBusy(false);
      setUrlProgress(null);
    }
  }, [probePath, t, url, urlBusy]);

  const progressLabel = urlProgress?.stage === "downloading-tool"
    ? t("urlStageTool")
    : urlProgress?.stage === "downloading-media"
      ? t("urlStageMedia")
      : urlProgress?.stage === "merging"
        ? t("urlStageMerge")
        : t("urlStageResolve");

  return (
    <main className="stage flex flex-1 flex-col items-center overflow-y-auto px-6 pt-[10vh] pb-12">
      <h1 className="rise-in text-center text-3xl leading-tight font-extrabold tracking-tight">{t("importTitle")}</h1>
      <p className="rise-in rise-in-1 mt-3 max-w-xl text-center text-[14px] leading-relaxed text-mut">{t("importDesc")}</p>

      <div
        className="drop-zone rise-in rise-in-2 mt-8 w-full max-w-2xl rounded-3xl p-3"
        data-dragging={dragging}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          // Electron 的拖放文件带真实路径;浏览器没有,忽略
          const dropped = e.dataTransfer.files[0] as (File & { path?: string }) | undefined;
          if (dropped?.path) void probePath(dropped.path);
        }}
      >
        <div className="drop-zone-inner flex flex-col items-center rounded-2xl px-8 py-10">
          <div className="icon-tile float-y flex h-14 w-14 items-center justify-center rounded-2xl">
            <LuFileVideo className="h-7 w-7" />
          </div>
          <button
            type="button"
            onClick={() => void pickFile()}
            disabled={busy}
            className="btn-flame mt-6 rounded-xl px-10 py-3 text-[15px] font-bold text-white disabled:opacity-50"
          >
            {busy ? <span className="shimmer">{t("probing")}</span> : t("importButton")}
          </button>
          <p className="mt-3 text-[13px] text-mut/80">{t("importDrop")}</p>
          <div className="mt-5 flex items-center gap-1.5">
            {FILE_CHIPS.map((chip) => (
              <span key={chip} className="chip rounded-md px-2 py-0.5 text-[10px] font-semibold tracking-wide">
                {chip}
              </span>
            ))}
          </div>
          <p className="mt-4 flex items-center gap-1.5 text-xs text-mut">
            <LuShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
            {t("importHint")}
          </p>
        </div>
      </div>

      <section className="rise-in rise-in-2 mt-5 w-full max-w-2xl rounded-2xl border border-line/80 bg-panel/55 p-4" aria-busy={urlBusy}>
        <div className="flex items-center gap-2">
          <LuLink aria-hidden="true" className="h-4 w-4 text-ember" />
          <h2 className="text-[13px] font-bold text-fg">{t("urlTitle")}</h2>
        </div>
        <p className="mt-1 text-[11.5px] leading-relaxed text-mut">{t("urlDesc")}</p>
        <div className="mt-3 flex gap-2">
          <label htmlFor="media-url" className="sr-only">{t("urlLabel")}</label>
          <input
            id="media-url"
            type="url"
            value={url}
            disabled={urlBusy || busy}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void importUrl();
            }}
            placeholder={t("urlPlaceholder")}
            className="min-w-0 flex-1 rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-[12.5px] text-fg outline-none transition-colors placeholder:text-mut/60 focus:border-ember/60 disabled:opacity-50"
          />
          {urlBusy ? (
            <button
              type="button"
              onClick={() => getApi().cancelUrlImport()}
              className="min-h-10 rounded-lg border border-line px-4 text-[12px] font-semibold text-mut transition-colors hover:border-red-500/40 hover:text-red-300"
            >
              {t("urlCancel")}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void importUrl()}
              disabled={busy || !url.trim()}
              className="btn-flame inline-flex min-h-10 items-center gap-2 rounded-lg px-4 text-[12px] font-bold text-white disabled:opacity-50"
            >
              <LuCircleArrowUp aria-hidden="true" className="h-4 w-4" />
              {t("urlButton")}
            </button>
          )}
        </div>
        {urlBusy && (
          <div className="mt-3" role="status" aria-live="polite">
            <div className="flex items-center justify-between gap-3 text-[11px] text-mut">
              <span className="flex items-center gap-1.5">
                <LuLoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin text-ember" />
                {progressLabel}
              </span>
              {urlProgress?.stage === "downloading-media" && (
                <span className="shrink-0 tabular-nums">
                  {formatTransfer(urlProgress.downloadedBytes)}
                  {urlProgress.totalBytes ? ` / ${formatTransfer(urlProgress.totalBytes)}` : ""}
                </span>
              )}
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line/70">
              <div
                className={`h-full rounded-full flame-gradient transition-[width] ${urlProgress?.fraction === undefined ? "w-1/3 animate-pulse" : ""}`}
                style={urlProgress?.fraction === undefined ? undefined : { width: `${Math.round(urlProgress.fraction * 100)}%` }}
              />
            </div>
            {urlProgress?.stage === "downloading-tool" && <p className="mt-1.5 text-[10.5px] text-mut/75">{t("urlFirstUse")}</p>}
          </div>
        )}
      </section>

      <button
        type="button"
        onClick={() => setShowWatch(true)}
        className="rise-in rise-in-2 mt-5 inline-flex items-center gap-1.5 rounded-lg border border-line px-4 py-2 text-[12.5px] font-semibold text-mut transition-colors hover:border-mut hover:text-fg"
      >
        <LuFolderSearch className="h-4 w-4" />
        {t("watchEntry")}
      </button>

      {error && <p role="alert" className="mt-5 text-sm text-red-400">{error}</p>}
      {showWatch && <WatchFolderModal onClose={() => setShowWatch(false)} />}
    </main>
  );
}

export default function App(): React.JSX.Element {
  const tc = useT("common");
  const t = useT("workbench");
  const th = useT("home");
  const tp = useT("projects");
  const { locale, setLocale } = useLocaleStore();
  const session = useSession();
  const { file, transcript, candidates, detecting, exporting, settingsOpen, auto } = session;
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [restored, setRestored] = useState(false);
  const [checkpointWarning, setCheckpointWarning] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeProjectId, setActiveProjectIdState] = useState<string | null>(null);
  const [showProjects, setShowProjects] = useState(false);
  const activeProjectIdRef = useRef<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setActiveProjectId = useCallback((id: string | null): void => {
    activeProjectIdRef.current = id;
    setActiveProjectIdState(id);
  }, []);

  const replaceProject = useCallback((project: ProjectSummary): void => {
    setProjects((current) => {
      const next = [project, ...current.filter((item) => item.id !== project.id)];
      return next.sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt) || b.updatedAt.localeCompare(a.updatedAt));
    });
  }, []);

  const clearPendingSave = useCallback((): void => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
  }, []);

  const saveCheckpoint = useCallback(async (id: string, checkpoint: ReturnType<typeof sessionCheckpointFromState>): Promise<boolean> => {
    if (!checkpoint) return true;
    try {
      const saved = await getApi().projectSave(id, checkpoint);
      setCheckpointWarning(!saved);
      if (saved) {
        setProjects((current) => current.map((project) => project.id === id
          ? { ...project, hasTranscript: checkpoint.transcript !== null, candidateCount: checkpoint.candidates?.length ?? 0, updatedAt: checkpoint.savedAt }
          : project));
      }
      return saved;
    } catch {
      setCheckpointWarning(true);
      return false;
    }
  }, []);

  const flushActiveProject = useCallback(async (): Promise<void> => {
    clearPendingSave();
    const id = activeProjectIdRef.current;
    const checkpoint = sessionCheckpointFromState(useSession.getState());
    if (id && checkpoint) await saveCheckpoint(id, checkpoint);
  }, [clearPendingSave, saveCheckpoint]);

  const closeCurrentProject = useCallback(async (): Promise<void> => {
    await flushActiveProject();
    await getApi().projectClose().catch(() => {});
    setActiveProjectId(null);
    setCheckpointWarning(false);
    const current = useSession.getState();
    current.setSettingsOpen(false);
    current.reset();
  }, [flushActiveProject, setActiveProjectId]);

  const importFileAsProject = useCallback(async (file: ProbedFile): Promise<void> => {
    clearPendingSave();
    if (activeProjectIdRef.current) await getApi().projectClose().catch(() => {});
    const checkpoint = initialSessionCheckpoint(file);
    const result = await getApi().projectCreate(checkpoint);
    if (!result?.checkpoint) throw new Error("project create failed");
    setActiveProjectId(result.project.id);
    replaceProject(result.project);
    useSession.getState().restore(result.checkpoint);
    setCheckpointWarning(false);
    setShowProjects(false);
  }, [clearPendingSave, replaceProject, setActiveProjectId]);

  const openSavedProject = useCallback(async (id: string): Promise<void> => {
    if (id === activeProjectIdRef.current && useSession.getState().file) {
      setShowProjects(false);
      return;
    }
    await flushActiveProject();
    const result = await getApi().projectOpen(id);
    if (!result) throw new Error("project open failed");
    setActiveProjectId(result.project.id);
    replaceProject(result.project);
    setCheckpointWarning(false);
    const current = useSession.getState();
    current.setSettingsOpen(false);
    if (result.checkpoint) {
      current.restore(result.checkpoint);
      setShowProjects(false);
    } else {
      current.reset();
      setShowProjects(true);
    }
  }, [flushActiveProject, replaceProject, setActiveProjectId]);

  const relinkSavedProject = useCallback(async (id: string): Promise<boolean> => {
    const path = await getApi().selectMedia();
    if (!path) return true;
    if (id !== activeProjectIdRef.current) await flushActiveProject();
    const result = await getApi().projectRelink(id, path);
    if (!result?.checkpoint) return false;
    setActiveProjectId(result.project.id);
    replaceProject(result.project);
    setCheckpointWarning(false);
    useSession.getState().restore(result.checkpoint);
    setShowProjects(false);
    return true;
  }, [flushActiveProject, replaceProject, setActiveProjectId]);

  const renameSavedProject = useCallback(async (id: string, name: string): Promise<void> => {
    const project = await getApi().projectRename(id, name);
    if (!project) throw new Error("project rename failed");
    replaceProject(project);
  }, [replaceProject]);

  const deleteSavedProject = useCallback(async (id: string): Promise<void> => {
    if (id === activeProjectIdRef.current) clearPendingSave();
    if (!(await getApi().projectDelete(id))) throw new Error("project delete failed");
    setProjects((current) => current.filter((project) => project.id !== id));
    if (id === activeProjectIdRef.current) {
      setActiveProjectId(null);
      setCheckpointWarning(false);
      useSession.getState().reset();
    }
  }, [clearPendingSave, setActiveProjectId]);

  useEffect(() => {
    let active = true;
    void getApi().projectWorkspaceGet()
      .then((workspace) => {
        if (!active) return;
        setProjects(workspace.projects);
        setActiveProjectId(workspace.activeProjectId);
        if (workspace.active?.checkpoint) {
          useSession.getState().restore(workspace.active.checkpoint);
          setRestored(true);
        } else if (workspace.projects.length > 0) {
          setShowProjects(true);
        }
      })
      .catch(() => {})
      .finally(() => { if (active) setHydrated(true); });
    return () => { active = false; };
  }, [setActiveProjectId]);

  useEffect(() => {
    if (!hydrated) return;
    const unsubscribe = useSession.subscribe((state) => {
      clearPendingSave();
      const projectId = activeProjectIdRef.current;
      if (!state.file) {
        setCheckpointWarning(false);
        return;
      }
      if (!projectId) return;
      saveTimerRef.current = setTimeout(() => {
        if (activeProjectIdRef.current !== projectId) return;
        const checkpoint = sessionCheckpointFromState(useSession.getState());
        void saveCheckpoint(projectId, checkpoint);
      }, 650);
    });
    return () => {
      unsubscribe();
      clearPendingSave();
    };
  }, [clearPendingSave, hydrated, saveCheckpoint]);

  useEffect(() => {
    if (!restored) return;
    const timer = setTimeout(() => setRestored(false), 4500);
    return () => clearTimeout(timer);
  }, [restored]);

  useEffect(() => {
    void getApi()
      .checkUpdate()
      .then((u) => {
        if (u?.hasUpdate) setUpdate(u);
      })
      .catch(() => {});
  }, []);

  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  const nextLocale = LOCALE_LIST[(LOCALE_LIST.indexOf(locale) + 1) % LOCALE_LIST.length];
  const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

  if (!hydrated) {
    return <div role="status" aria-live="polite" className="flex h-full items-center justify-center text-sm text-mut">{tc("restoringSession")}</div>;
  }

  return (
    <div className="relative flex h-full flex-col">
      {/* ---- 顶栏:品牌 + 项目 + 管线状态 ---- */}
      <header
        className="z-10 flex h-12 shrink-0 items-center gap-3 border-b border-line/70 bg-panel/55 px-4 backdrop-blur-xl"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        <div className="flex shrink-0 items-center gap-2">
          <LogoMark size={26} />
          <LogoWordmark zh={locale === "zh"} />
        </div>
        {file && (
          <>
            <div className="h-4.5 w-px shrink-0 bg-line" />
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-[12.5px] font-semibold" title={file.path}>
                {activeProject?.name ?? displayName(file.path)}
              </span>
              <span className="shrink-0 font-mono text-[10.5px] text-mut tabular-nums">{formatDuration(file.durationSec)}</span>
              <button
                type="button"
                title={t("changeFileHint")}
                onClick={() => void closeCurrentProject()}
                style={noDrag}
                className="shrink-0 rounded p-1 text-mut transition-colors hover:text-fg"
              >
                <LuX aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            </div>
          </>
        )}
        <div className="min-w-0 flex-1" />
        {/* 管线状态:替代三步条,只报状态不锁路径 */}
        {file && (
          <nav className="flex shrink-0 items-center gap-1.5 overflow-hidden" style={noDrag}>
            <PipeChip label={t("pipeTranscribe")} state={transcript ? "done" : "busy"} />
            <PipeChip
              label={t("pipeDetect")}
              state={candidates ? "done" : detecting ? "busy" : "idle"}
              extra={candidates ? t("pipeCandidates", { n: candidates.length }) : undefined}
            />
            <PipeChip label={t("pipeExport")} state={exporting ? "busy" : "idle"} />
          </nav>
        )}
        <div className="flex shrink-0 items-center gap-2" style={noDrag}>
          {update && (
            <button
              type="button"
              onClick={() => getApi().openUrl(update.url)}
              title={tc("updateHint", { v: update.latest })}
              className="flame-gradient flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-bold text-white"
            >
              <LuCircleArrowUp className="h-3.5 w-3.5" />
              {tc("updateChip", { v: update.latest })}
            </button>
          )}
          {file && !auto && !exporting && (
            <button
              type="button"
              title={th("autoRunHint")}
              onClick={() => session.setAuto(true)}
              className="btn-flame flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold text-white"
            >
              <LuWandSparkles className="h-3.5 w-3.5" />
              {th("autoRun")}
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowProjects(true)}
            title={tp("title")}
            className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors ${showProjects ? "border-ember/50 bg-ember/10 text-ember" : "border-line text-mut hover:border-mut hover:text-fg"}`}
          >
            <LuFolderOpen className="h-3.5 w-3.5" />
            <span>{tp("title")}</span>
            {projects.length > 0 && <span className="font-mono text-[9.5px] tabular-nums opacity-70">{projects.length}</span>}
          </button>
          <button
            type="button"
            onClick={() => session.setSettingsOpen(!settingsOpen)}
            title={tc("settings")}
            className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
              settingsOpen ? "border-ember/50 bg-ember/10 text-ember" : "border-line text-mut hover:border-mut hover:text-fg"
            }`}
          >
            <LuSettings className="h-3.5 w-3.5" />
            {tc("settings")}
          </button>
          <button
            type="button"
            onClick={() => setLocale(nextLocale)}
            title={tc("language")}
            className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs text-mut transition-colors hover:border-mut hover:text-fg"
          >
            <LuLanguages className="h-3.5 w-3.5" />
            {REGISTRY[nextLocale].label}
          </button>
        </div>
      </header>

      {/* ---- 视图分派:设置中心 > 工作台 > 导入页 ---- */}
      {settingsOpen ? <SettingsView /> : file ? <Workbench onCloseProject={() => void closeCurrentProject()} /> : <ImportStage onImportFile={importFileAsProject} />}
      {showProjects && (
        <ProjectLibraryModal
          projects={projects}
          activeProjectId={activeProjectId}
          onClose={() => setShowProjects(false)}
          onNew={async () => { await closeCurrentProject(); setShowProjects(false); }}
          onOpen={openSavedProject}
          onRelink={relinkSavedProject}
          onRename={renameSavedProject}
          onDelete={deleteSavedProject}
        />
      )}
      {restored && (
        <div role="status" aria-live="polite" className="pointer-events-none fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-emerald-400/25 bg-panel/95 px-4 py-2.5 text-xs font-medium text-emerald-300 shadow-xl backdrop-blur">
          {tc("sessionRestored")}
        </div>
      )}
      {checkpointWarning && (
        <div role="alert" className="fixed bottom-5 left-1/2 z-50 max-w-lg -translate-x-1/2 rounded-lg border border-amber-400/30 bg-panel/95 px-4 py-2.5 text-xs font-medium text-amber-200 shadow-xl backdrop-blur">
          {tc("sessionSaveFailed")}
        </div>
      )}
    </div>
  );
}
