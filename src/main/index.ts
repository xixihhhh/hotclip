/**
 * Electron main process: window lifecycle + IPC surface.
 * All heavy pipeline work lives in src/core and is invoked from here,
 * never from the renderer directly.
 */
import { app, shell, BrowserWindow, ipcMain, dialog } from "electron";
import { join } from "path";
import { basename, extname } from "path";
import { stat } from "fs/promises";
import { probeMedia } from "@core/probe";
import { SenseVoiceEngine } from "@core/transcribe/sensevoice";
import { ParaformerEngine } from "@core/transcribe/paraformer";
import { FireRedEngine } from "@core/transcribe/firered";
import { ElevenLabsEngine } from "@core/transcribe/elevenlabs";
import { readTranscriptCache, writeTranscriptCache } from "@core/transcribe/cache";
import { isModelInstalled, ensureModel, SENSEVOICE_MODEL, PARAFORMER_MODEL, FIRERED_MODEL, SEGMENTATION_MODEL, SPEAKER_EMBEDDING_MODEL } from "@core/models";
import { runDiarization, labelTranscript } from "@core/diarize";
import { ASR_CATALOG } from "../shared/asr-catalog";
import { detectHighlights } from "@core/highlight/detect";
import { collectSignals } from "@core/signals";
import { exportClips, sanitizeFilename } from "@core/export";
import { sliceWords } from "@core/subtitle";
import { renderCaptionOverlay } from "./overlay-renderer";
import type { Transcript, LlmConfig, HighlightCandidate, ExportOptions } from "../shared/api-types";

const VIDEO_EXTENSIONS = ["mp4", "mkv", "mov", "flv", "ts", "webm", "avi", "m4v"];
const AUDIO_EXTENSIONS = ["mp3", "m4a", "wav", "aac", "flac"];

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: "HotClip",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on("ready-to-show", () => mainWindow.show());

  // External links open in the system browser, never inside the app shell.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

// ---- IPC: file import + probing (wizard step 1) ----

ipcMain.handle("hotclip:select-media", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [
      { name: "Video / Audio", extensions: [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle("hotclip:probe-media", async (_event, filePath: unknown) => {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new Error("probe-media requires a file path");
  }
  return probeMedia(filePath);
});

// ---- IPC: transcription (wizard step 2) ----
// Engine instances are cheap; models are downloaded once into userData.

const modelsRoot = (): string => join(app.getPath("userData"), "models");
const transcriptCacheDir = (): string => join(app.getPath("userData"), "transcript-cache");

/** catalog id → engine factory + its model asset (for install checks). */
const ASR_ENGINES = {
  sensevoice: { make: () => new SenseVoiceEngine(modelsRoot()), asset: SENSEVOICE_MODEL },
  paraformer: { make: () => new ParaformerEngine(modelsRoot()), asset: PARAFORMER_MODEL },
  fireredasr: { make: () => new FireRedEngine(modelsRoot()), asset: FIRERED_MODEL },
} as const;

ipcMain.handle("hotclip:list-asr-engines", async () => {
  return Promise.all(
    ASR_CATALOG.map(async (facts) => {
      const entry = ASR_ENGINES[facts.id as keyof typeof ASR_ENGINES];
      const installed = entry ? await isModelInstalled(modelsRoot(), entry.asset) : false;
      return { ...facts, installed };
    })
  );
});

let transcribing = false;

// Tier-0 signal collection is slow on long sources (full audio + downscaled
// video scan), so it kicks off IN PARALLEL with transcription — by the time
// the user reaches highlight detection the evidence is already there.
const signalsCache = new Map<string, Promise<import("@core/signals").MediaSignals | undefined>>();

function warmSignals(filePath: string): Promise<import("@core/signals").MediaSignals | undefined> {
  let p = signalsCache.get(filePath);
  if (!p) {
    p = collectSignals(filePath).catch(() => undefined);
    signalsCache.set(filePath, p);
    // bound the cache — sources are large strings but promises are cheap;
    // keep the last few files only
    if (signalsCache.size > 4) {
      const first = signalsCache.keys().next().value;
      if (first !== undefined) signalsCache.delete(first);
    }
  }
  return p;
}

ipcMain.handle("hotclip:transcribe", async (event, filePath: unknown, engineId: unknown, apiKey: unknown) => {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new Error("transcribe requires a file path");
  }
  if (transcribing) throw new Error("another transcription is already running");
  transcribing = true;
  void warmSignals(filePath); // runs alongside transcription
  try {
    const resolvedEngineId =
      engineId === "elevenlabs"
        ? "elevenlabs"
        : typeof engineId === "string" && engineId in ASR_ENGINES
          ? engineId
          : "sensevoice";
    // Persistent cache: same file (size+mtime) + same engine → skip the slowest
    // step entirely. Stat may fail (unusual paths) — then we just transcribe.
    let fileStat: { size: number; mtimeMs: number } | undefined;
    try {
      fileStat = await stat(filePath);
    } catch {
      fileStat = undefined;
    }
    if (fileStat) {
      const cached = await readTranscriptCache(transcriptCacheDir(), filePath, fileStat, resolvedEngineId);
      if (cached) return cached;
    }
    // cloud engines take the user's key for this one call — never persisted here
    const engine =
      resolvedEngineId === "elevenlabs"
        ? new ElevenLabsEngine(typeof apiKey === "string" ? apiKey : "")
        : ASR_ENGINES[resolvedEngineId as keyof typeof ASR_ENGINES].make();
    const result = await engine.transcribe(filePath, {
      onProgress: (p) => {
        // renderer may already be gone on quit — guard the send
        if (!event.sender.isDestroyed()) event.sender.send("hotclip:transcribe-progress", p);
      },
    });
    if (fileStat && result?.segments?.length) {
      void writeTranscriptCache(transcriptCacheDir(), filePath, fileStat, resolvedEngineId, result);
    }
    return result;
  } finally {
    transcribing = false;
  }
});

// ---- IPC: highlight detection (wizard step 2, after transcription) ----
// The LLM key comes from the renderer's settings; it is used for this one
// call and never persisted in the main process.

ipcMain.handle(
  "hotclip:detect-highlights",
  async (_event, transcript: unknown, llm: unknown, filePath: unknown, diarize: unknown) => {
    let t = transcript as Transcript;
    const config = llm as LlmConfig;
    if (!t || !Array.isArray(t.segments)) throw new Error("detect-highlights requires a transcript");
    if (!config?.baseUrl || !config?.model) throw new Error("请先在设置里配置 LLM(baseUrl/model)");
    // Tier-0 audiovisual evidence (loudness peaks + cut density), capped so a
    // pathological source can never stall detection; failures degrade to none.
    let signals;
    if (typeof filePath === "string" && filePath.trim()) {
      // usually already resolved (warmed during transcription); cap the cold path
      signals = await Promise.race([
        warmSignals(filePath),
        new Promise<undefined>((r) => setTimeout(() => r(undefined), 120_000)),
      ]).catch(() => undefined);
    }
    // Multi-speaker attribution (opt-in): label the transcript so the LLM knows
    // who says what. Fail-open — a diarization hiccup must not block detection.
    let labeled: Transcript | undefined;
    if (diarize === true && typeof filePath === "string" && filePath.trim()) {
      t = await diarizeTranscript(t, filePath).catch(() => t);
      labeled = t; // surface the labeled transcript so export can color captions by speaker
    }
    const candidates = await detectHighlights(t, config, undefined, signals);
    return { candidates, transcript: labeled };
  }
);

/** Ensure diarization models, run, and label the transcript. Throws on failure. */
async function diarizeTranscript(t: Transcript, filePath: string): Promise<Transcript> {
  const root = modelsRoot();
  await ensureModel(root, SEGMENTATION_MODEL);
  await ensureModel(root, SPEAKER_EMBEDDING_MODEL);
  const turns = await runDiarization(filePath, root);
  return labelTranscript(t, turns);
}

// ---- IPC: export selected clips (wizard step 3) ----
// Output goes to ~/Movies/HotClip/<source-name>/ — a place beginners can find.

ipcMain.handle("hotclip:export-clips", async (event, filePath: unknown, clips: unknown, options: unknown) => {
  if (typeof filePath !== "string" || !filePath.trim()) throw new Error("export requires a file path");
  const list = clips as HighlightCandidate[];
  if (!Array.isArray(list) || list.length === 0) throw new Error("no clips selected");
  const opts = (options ?? {}) as ExportOptions;
  const style =
    opts.captionStyle && opts.captionStyle !== "none" && opts.transcript ? opts.captionStyle : undefined;
  const jumpCut = Boolean(opts.jumpCut && opts.transcript);
  const cleanFillers = Boolean(opts.cleanFillers && opts.transcript);
  const needWords = Boolean(style) || jumpCut || cleanFillers;
  const sourceName = sanitizeFilename(basename(filePath, extname(filePath)), "video");
  const outDir = join(app.getPath("videos"), "HotClip", sourceName);
  // bundled caption font: packaged → resources/fonts, dev → repo resources/fonts
  const fontsDir = app.isPackaged
    ? join(process.resourcesPath, "fonts")
    : join(app.getAppPath(), "resources", "fonts");
  return exportClips(
    filePath,
    list.map((c) => ({
      id: c.id,
      title: c.title,
      startSec: c.startSec,
      endSec: c.endSec,
      words: needWords ? sliceWords(opts.transcript!, c.startSec, c.endSec) : undefined,
      keywords: c.keywords,
      meta: {
        hook: c.hook,
        score: c.score,
        reason: c.reason,
        text: c.text,
        recommended: c.recommended,
        reviewNote: c.reviewNote,
        scoreDims: c.scoreDims,
        teaser: c.teaser,
      },
    })),
    outDir,
    {
      vertical: Boolean(opts.vertical),
      captionStyle: style,
      jumpCut,
      cleanFillers,
      trimUi: Boolean(opts.trimUi),
      titleCard: Boolean(opts.titleCard),
      normalizeLoudness: Boolean(opts.normalizeLoudness),
      faceTrack: true,
      modelsRoot: modelsRoot(),
      fontsDir,
      renderOverlay: renderCaptionOverlay,
    },
    (p) => {
      if (!event.sender.isDestroyed()) event.sender.send("hotclip:export-progress", p);
    }
  );
});

ipcMain.on("hotclip:reveal", (_event, path: unknown) => {
  if (typeof path === "string" && path.trim()) shell.showItemInFolder(path);
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
