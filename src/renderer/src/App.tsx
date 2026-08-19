/**
 * App 外壳:顶栏(项目名 + 管线状态 + 一键托管 + 设置)+ 视图分派。
 * 三步向导退役——没素材时是导入页,有素材即进「工作台」;设置中心全屏
 * 视图任何时刻可达。会话状态全部在 session store,视图切换不丢结果。
 * Electron(IPC)与纯浏览器(mock)双跑,后者是设计预览通路。
 */
import { useCallback, useState } from "react";
import {
  LuCheck,
  LuCircleArrowUp,
  LuFileVideo,
  LuFolderSearch,
  LuLanguages,
  LuSettings,
  LuShieldCheck,
  LuWandSparkles,
  LuX,
} from "react-icons/lu";
import { useT, useLocaleStore } from "./i18n/store";
import { LOCALE_LIST, REGISTRY } from "./i18n/messages";
import { getApi } from "./api/provider";
import { useSession } from "./stores/session-store";
import { LogoMark, LogoWordmark } from "./components/Logo";
import { Workbench } from "./components/Workbench";
import { SettingsView } from "./components/SettingsView";
import { WatchFolderModal } from "./components/WatchFolderModal";
import type { UpdateInfo } from "../../shared/api-types";
import { useEffect } from "react";
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
function ImportStage(): React.JSX.Element {
  const t = useT("home");
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showWatch, setShowWatch] = useState(false);

  const probePath = useCallback(
    async (path: string): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        const info = await getApi().probeMedia(path);
        session.setFile({ path, ...info });
      } catch {
        setError(t("probeFailed"));
      } finally {
        setBusy(false);
      }
    },
    [session, t]
  );

  const pickFile = useCallback(async (): Promise<void> => {
    setError(null);
    const path = await getApi().selectMedia();
    if (!path) return;
    await probePath(path);
  }, [probePath]);

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

      <button
        type="button"
        onClick={() => setShowWatch(true)}
        className="rise-in rise-in-2 mt-5 inline-flex items-center gap-1.5 rounded-lg border border-line px-4 py-2 text-[12.5px] font-semibold text-mut transition-colors hover:border-mut hover:text-fg"
      >
        <LuFolderSearch className="h-4 w-4" />
        {t("watchEntry")}
      </button>

      {error && <p className="mt-5 text-sm text-red-400">{error}</p>}
      {showWatch && <WatchFolderModal onClose={() => setShowWatch(false)} />}
    </main>
  );
}

export default function App(): React.JSX.Element {
  const tc = useT("common");
  const t = useT("workbench");
  const th = useT("home");
  const { locale, setLocale } = useLocaleStore();
  const session = useSession();
  const { file, transcript, candidates, detecting, exporting, settingsOpen, auto } = session;
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  useEffect(() => {
    void getApi()
      .checkUpdate()
      .then((u) => {
        if (u?.hasUpdate) setUpdate(u);
      })
      .catch(() => {});
  }, []);

  const nextLocale = LOCALE_LIST[(LOCALE_LIST.indexOf(locale) + 1) % LOCALE_LIST.length];
  const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

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
                {displayName(file.path)}
              </span>
              <span className="shrink-0 font-mono text-[10.5px] text-mut tabular-nums">{formatDuration(file.durationSec)}</span>
              <button
                type="button"
                title={t("changeFileHint")}
                onClick={() => session.reset()}
                style={noDrag}
                className="shrink-0 rounded p-1 text-mut transition-colors hover:text-fg"
              >
                <LuX className="h-3.5 w-3.5" />
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
      {settingsOpen ? <SettingsView /> : file ? <Workbench /> : <ImportStage />}
    </div>
  );
}
