/**
 * App shell: 3-step wizard (Import → Pick highlights → Export).
 * Step 1 (import + probe) is live; steps 2-3 land with the pipeline milestones.
 * Runs both inside Electron (IPC api) and in a plain browser (mock api) —
 * the latter is the design-preview path today and the web-platform seam later.
 */
import { useCallback, useState } from "react";
import { useT, useLocaleStore } from "./i18n/store";
import { LOCALE_LIST, REGISTRY } from "./i18n/messages";
import { getApi } from "./api/provider";
import type { MediaInfo } from "../../shared/api-types";
import "./app.css";

interface ProbedFile extends MediaInfo {
  path: string;
}

function formatDuration(totalSeconds: number): string {
  const s = Math.floor(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Basename without extension — good enough for display, avoids a path lib. */
function displayName(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.[^.]+$/, "");
}

export default function App(): React.JSX.Element {
  const tc = useT("common");
  const t = useT("home");
  const { locale, setLocale } = useLocaleStore();
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<ProbedFile | null>(null);

  const probePath = useCallback(
    async (path: string): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        const info = await getApi().probeMedia(path);
        setFile({ path, ...info });
      } catch {
        setError(t("probeFailed"));
      } finally {
        setBusy(false);
      }
    },
    [t]
  );

  const pickFile = useCallback(async (): Promise<void> => {
    setError(null);
    const path = await getApi().selectMedia();
    if (!path) return;
    await probePath(path);
  }, [probePath]);

  const onDrop = useCallback(
    (e: React.DragEvent): void => {
      e.preventDefault();
      setDragging(false);
      // Electron exposes real paths on dropped files; browsers do not — ignore there.
      const dropped = e.dataTransfer.files[0] as (File & { path?: string }) | undefined;
      if (dropped?.path) void probePath(dropped.path);
    },
    [probePath]
  );

  const nextLocale = LOCALE_LIST[(LOCALE_LIST.indexOf(locale) + 1) % LOCALE_LIST.length];
  const steps = [t("stepImport"), t("stepHighlights"), t("stepExport")];
  const features: Array<[string, string, string]> = [
    ["🔒", t("featLocalTitle"), t("featLocalDesc")],
    ["🆓", t("featFreeTitle"), t("featFreeDesc")],
    ["✨", t("featAiTitle"), t("featAiDesc")],
  ];

  return (
    <div className="flex h-full flex-col">
      {/* ---- top bar ---- */}
      <header
        className="flex h-14 shrink-0 items-center justify-between border-b border-line/70 bg-panel/60 px-5 backdrop-blur-xl"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        <div className="flex items-center gap-2.5">
          <div className="flame-gradient flex h-8 w-8 items-center justify-center rounded-lg text-base shadow-lg">
            🔥
          </div>
          <span className="text-[15px] font-bold tracking-tight">{tc("appName")}</span>
        </div>

        <nav className="flex items-center gap-1.5">
          {steps.map((label, i) => (
            <div key={label} className="flex items-center gap-1.5">
              <div
                className={`flex h-7 items-center gap-1.5 rounded-full px-3.5 text-xs font-medium transition-colors ${
                  i === 0 ? "flame-gradient text-white shadow-md" : "text-mut"
                }`}
              >
                <span
                  className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold ${
                    i === 0 ? "bg-white/25" : "bg-line"
                  }`}
                >
                  {i + 1}
                </span>
                {label}
              </div>
              {i < steps.length - 1 && <div className="h-px w-5 bg-line" />}
            </div>
          ))}
        </nav>

        <button
          type="button"
          onClick={() => setLocale(nextLocale)}
          title={tc("language")}
          className="rounded-md border border-line px-2.5 py-1 text-xs text-mut transition-colors hover:border-mut hover:text-fg"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          {REGISTRY[nextLocale].label}
        </button>
      </header>

      {/* ---- stage ---- */}
      <main className="stage-glow flex flex-1 flex-col items-center overflow-y-auto px-6 pt-[9vh] pb-12">
        <h1 className="text-center text-[34px] leading-tight font-extrabold tracking-tight">
          {t("importTitle")}
        </h1>
        <p className="mt-3 max-w-xl text-center text-[15px] text-mut">{t("importDesc")}</p>

        {/* drop zone */}
        <div
          className="drop-ring mt-10 flex w-full max-w-2xl flex-col items-center rounded-2xl px-8 py-12"
          data-dragging={dragging}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <button
            type="button"
            onClick={pickFile}
            disabled={busy}
            className="btn-flame rounded-xl px-10 py-3.5 text-[16px] font-bold text-white disabled:opacity-50"
          >
            {busy ? <span className="shimmer">{t("probing")}</span> : t("importButton")}
          </button>
          <p className="mt-3 text-[13px] text-mut/80">{t("importDrop")}</p>
          <p className="mt-6 flex items-center gap-1.5 text-xs text-mut">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
            {t("importHint")}
          </p>
        </div>

        {error && <p className="mt-5 text-sm text-red-400">{error}</p>}

        {/* probed file card */}
        {file && (
          <section className="rise-in mt-8 w-full max-w-2xl rounded-2xl border border-line bg-panel p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="truncate text-[17px] font-bold">{displayName(file.path)}</h2>
                <p className="mt-1 truncate text-xs text-mut">{file.path}</p>
              </div>
              <span className="flame-gradient shrink-0 rounded-full px-3 py-1 text-xs font-bold text-white">
                {formatDuration(file.durationSec)}
              </span>
            </div>

            <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {(
                [
                  [t("duration"), formatDuration(file.durationSec)],
                  file.hasVideo
                    ? [t("resolution"), `${file.width}×${file.height}`]
                    : [t("codec"), t("audioOnly")],
                  [t("framerate"), file.hasVideo && file.fps ? `${file.fps} fps` : "—"],
                  [t("codec"), [file.videoCodec, file.audioCodec].filter(Boolean).join(" / ") || "—"],
                ] as Array<[string, string]>
              ).map(([label, value]) => (
                <div key={label + value} className="rounded-xl bg-panel-2 px-3.5 py-3">
                  <dt className="text-[11px] text-mut">{label}</dt>
                  <dd className="mt-0.5 truncate text-[14px] font-semibold">{value}</dd>
                </div>
              ))}
            </dl>

            <p className="flame-text mt-5 border-t border-dashed border-line pt-4 text-[13px] font-semibold">
              {t("comingSoon")}
            </p>
          </section>
        )}

        {/* feature cards */}
        {!file && (
          <div className="mt-12 grid w-full max-w-2xl grid-cols-1 gap-3 sm:grid-cols-3">
            {features.map(([icon, title, desc]) => (
              <div
                key={title}
                className="rounded-xl border border-line/60 bg-panel/50 px-4 py-4 text-left transition-colors hover:border-line hover:bg-panel"
              >
                <div className="text-lg">{icon}</div>
                <div className="mt-1.5 text-[13px] font-bold">{title}</div>
                <div className="mt-0.5 text-xs leading-relaxed text-mut">{desc}</div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
