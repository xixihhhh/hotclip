/**
 * App shell: 3-step wizard (Import → Pick highlights → Export).
 * Step 1 (import + probe) is live; steps 2-3 land with the pipeline milestones.
 * Runs both inside Electron (IPC api) and in a plain browser (mock api) —
 * the latter is the design-preview path today and the web-platform seam later.
 */
import { useCallback, useState } from "react";
import {
  LuFileVideo,
  LuShieldCheck,
  LuBadgeCheck,
  LuSparkles,
  LuLanguages,
  LuClock3,
  LuProportions,
  LuGauge,
  LuFileCode2,
  LuCircleCheck,
  LuAudioLines,
} from "react-icons/lu";
import { useT, useLocaleStore } from "./i18n/store";
import { LOCALE_LIST, REGISTRY } from "./i18n/messages";
import { getApi } from "./api/provider";
import type { MediaInfo } from "../../shared/api-types";
import { LogoMark, LogoWordmark } from "./components/Logo";
import { TranscribeView } from "./components/TranscribeView";
import { HighlightsView } from "./components/HighlightsView";
import { ExportView } from "./components/ExportView";
import type { Transcript, HighlightCandidate, ExportOptions } from "../../shared/api-types";
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

const FILE_CHIPS = ["MP4", "MKV", "MOV", "FLV", "MP3"];

export default function App(): React.JSX.Element {
  const tc = useT("common");
  const t = useT("home");
  const { locale, setLocale } = useLocaleStore();
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<ProbedFile | null>(null);
  /** 0 = import, 1 = transcribe & pick highlights, 2 = export (later). */
  const [step, setStep] = useState(0);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  /** Within step 1: transcript view first, highlights after the CTA. */
  const [phase, setPhase] = useState<"transcribe" | "highlights">("transcribe");
  /** Clips + render toggles chosen for export (moves the wizard to step 2). */
  const [exporting, setExporting] = useState<{
    clips: HighlightCandidate[];
    options: Pick<ExportOptions, "vertical" | "karaoke">;
  } | null>(null);

  const restart = (): void => {
    setFile(null);
    setTranscript(null);
    setPhase("transcribe");
    setExporting(null);
    setStep(0);
  };

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
  const features = [
    { Icon: LuShieldCheck, title: t("featLocalTitle"), desc: t("featLocalDesc") },
    { Icon: LuBadgeCheck, title: t("featFreeTitle"), desc: t("featFreeDesc") },
    { Icon: LuSparkles, title: t("featAiTitle"), desc: t("featAiDesc") },
  ];

  return (
    <div className="flex h-full flex-col">
      {/* ---- top bar ---- */}
      <header
        className="z-10 flex h-14 shrink-0 items-center justify-between border-b border-line/70 bg-panel/55 px-5 backdrop-blur-xl"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        <div className="flex items-center gap-2.5">
          <LogoMark size={30} />
          <LogoWordmark zh={locale === "zh"} />
        </div>

        <nav className="flex items-center">
          {steps.map((label, i) => (
            <div key={label} className="flex items-center">
              <div
                className={`flex h-7 items-center gap-1.5 rounded-full px-3.5 text-xs font-medium whitespace-nowrap transition-colors ${
                  i === step ? "flame-gradient text-white shadow-md" : i < step ? "text-ember" : "text-mut"
                }`}
              >
                <span
                  className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold ${
                    i === step ? "bg-white/25" : i < step ? "bg-ember/20" : "bg-line"
                  }`}
                >
                  {i < step ? "✓" : i + 1}
                </span>
                {label}
              </div>
              {i < steps.length - 1 && <div className="mx-1 h-px w-6 bg-line" />}
            </div>
          ))}
        </nav>

        <button
          type="button"
          onClick={() => setLocale(nextLocale)}
          title={tc("language")}
          className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs text-mut transition-colors hover:border-mut hover:text-fg"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <LuLanguages className="h-3.5 w-3.5" />
          {REGISTRY[nextLocale].label}
        </button>
      </header>

      {/* ---- stage ---- */}
      <main className="stage flex flex-1 flex-col items-center overflow-y-auto px-6 pt-[8vh] pb-12">
        {step === 1 && file && phase === "transcribe" && (
          <TranscribeView
            filePath={file.path}
            cached={transcript}
            onBack={() => {
              setTranscript(null);
              setStep(0);
            }}
            onDone={setTranscript}
            onFindHighlights={transcript ? () => setPhase("highlights") : undefined}
          />
        )}
        {step === 1 && transcript && phase === "highlights" && (
          <HighlightsView
            transcript={transcript}
            onBack={() => setPhase("transcribe")}
            onExport={(clips, options) => {
              setExporting({ clips, options });
              setStep(2);
            }}
          />
        )}
        {step === 2 && file && exporting && transcript && (
          <ExportView
            filePath={file.path}
            clips={exporting.clips}
            options={exporting.options}
            transcript={transcript}
            onBack={() => {
              setExporting(null);
              setStep(1);
            }}
            onRestart={restart}
          />
        )}

        {step === 0 && (
        <>
        <h1 className="rise-in text-center text-4xl leading-tight font-extrabold tracking-tight">
          {t("importTitle")}
        </h1>
        <p className="rise-in rise-in-1 mt-3.5 max-w-xl text-center text-[15px] leading-relaxed text-mut">
          {t("importDesc")}
        </p>

        {/* drop zone */}
        <div
          className="drop-zone rise-in rise-in-2 mt-9 w-full max-w-2xl rounded-3xl p-3"
          data-dragging={dragging}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <div className="drop-zone-inner flex flex-col items-center rounded-2xl px-8 py-11">
            <div className="icon-tile float-y flex h-16 w-16 items-center justify-center rounded-2xl">
              <LuFileVideo className="h-8 w-8" />
            </div>

            <button
              type="button"
              onClick={pickFile}
              disabled={busy}
              className="btn-flame mt-7 rounded-xl px-11 py-3.5 text-[15px] font-bold text-white disabled:opacity-50"
            >
              {busy ? <span className="shimmer">{t("probing")}</span> : t("importButton")}
            </button>
            <p className="mt-3 text-[13px] text-mut/80">{t("importDrop")}</p>

            <div className="mt-6 flex items-center gap-1.5">
              {FILE_CHIPS.map((chip) => (
                <span key={chip} className="chip rounded-md px-2 py-0.5 text-[10px] font-semibold tracking-wide">
                  {chip}
                </span>
              ))}
            </div>

            <p className="mt-5 flex items-center gap-1.5 text-xs text-mut">
              <LuShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
              {t("importHint")}
            </p>
          </div>
        </div>

        {error && <p className="mt-5 text-sm text-red-400">{error}</p>}

        {/* probed file card */}
        {file && (
          <section className="card rise-in mt-8 w-full max-w-2xl rounded-2xl p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div className="flex min-w-0 items-center gap-3">
                <div className="icon-tile flex h-11 w-11 shrink-0 items-center justify-center rounded-xl">
                  {file.hasVideo ? <LuFileVideo className="h-5.5 w-5.5" /> : <LuAudioLines className="h-5.5 w-5.5" />}
                </div>
                <div className="min-w-0">
                  <h2 className="truncate text-[17px] font-bold">{displayName(file.path)}</h2>
                  <p className="mt-0.5 truncate text-xs text-mut">{file.path}</p>
                </div>
              </div>
              <span className="flame-gradient flex shrink-0 items-center gap-1 rounded-full px-3 py-1 text-xs font-bold text-white">
                <LuClock3 className="h-3 w-3" />
                {formatDuration(file.durationSec)}
              </span>
            </div>

            <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {(
                [
                  { Icon: LuClock3, label: t("duration"), value: formatDuration(file.durationSec) },
                  file.hasVideo
                    ? { Icon: LuProportions, label: t("resolution"), value: `${file.width}×${file.height}` }
                    : { Icon: LuAudioLines, label: t("codec"), value: t("audioOnly") },
                  { Icon: LuGauge, label: t("framerate"), value: file.hasVideo && file.fps ? `${file.fps} fps` : "—" },
                  {
                    Icon: LuFileCode2,
                    label: t("codec"),
                    value: [file.videoCodec, file.audioCodec].filter(Boolean).join(" / ") || "—",
                  },
                ] as Array<{ Icon: typeof LuClock3; label: string; value: string }>
              ).map(({ Icon, label, value }) => (
                <div key={label + value} className="rounded-xl bg-panel-2 px-3.5 py-3">
                  <dt className="flex items-center gap-1 text-[11px] text-mut">
                    <Icon className="h-3 w-3" />
                    {label}
                  </dt>
                  <dd className="mt-1 truncate text-[14px] font-semibold">{value}</dd>
                </div>
              ))}
            </dl>

            <div className="mt-5 flex items-center justify-between border-t border-dashed border-line pt-4">
              <p className="flex items-center gap-1.5 text-[13px] text-mut">
                <LuCircleCheck className="h-4 w-4 text-emerald-400" />
                {t("importHint")}
              </p>
              <button
                type="button"
                onClick={() => setStep(1)}
                className="btn-flame rounded-lg px-6 py-2.5 text-[14px] font-bold text-white"
              >
                {t("startTranscribe")}
              </button>
            </div>
          </section>
        )}

        {/* feature cards */}
        {!file && (
          <div className="mt-11 grid w-full max-w-2xl grid-cols-1 gap-3 sm:grid-cols-3">
            {features.map(({ Icon, title, desc }, i) => (
              <div
                key={title}
                className={`card card-hover rise-in rise-in-${i + 1} rounded-2xl px-4.5 py-4.5 text-left`}
              >
                <div className="icon-tile flex h-9 w-9 items-center justify-center rounded-lg">
                  <Icon className="h-4.5 w-4.5" />
                </div>
                <div className="mt-2.5 text-[13.5px] font-bold">{title}</div>
                <div className="mt-1 text-xs leading-relaxed text-mut">{desc}</div>
              </div>
            ))}
          </div>
        )}
        </>
        )}
      </main>
    </div>
  );
}
