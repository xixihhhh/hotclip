/**
 * Electron main process: window lifecycle + IPC surface.
 * All heavy pipeline work lives in src/core and is invoked from here,
 * never from the renderer directly.
 */
import { app, shell, BrowserWindow, ipcMain, dialog, protocol } from "electron";
import { join } from "path";
import { basename, extname } from "path";
import { stat, readFile, writeFile, readdir } from "fs/promises";
import { createReadStream } from "fs";
import { Readable } from "stream";
import { extractPeaks } from "@core/audio-peaks";
import { resolveByteRange } from "@core/media-range";
import { sanitizeBrand } from "@core/brand";
import { probeMedia } from "@core/probe";
import { SenseVoiceEngine } from "@core/transcribe/sensevoice";
import { ParaformerEngine } from "@core/transcribe/paraformer";
import { FireRedEngine } from "@core/transcribe/firered";
import { ElevenLabsEngine } from "@core/transcribe/elevenlabs";
import { readTranscriptCache, writeTranscriptCache } from "@core/transcribe/cache";
import { isModelInstalled, ensureModel, SENSEVOICE_MODEL, PARAFORMER_MODEL, FIRERED_MODEL, SEGMENTATION_MODEL, SPEAKER_EMBEDDING_MODEL } from "@core/models";
import { runDiarization, labelTranscript } from "@core/diarize";
import { ASR_CATALOG } from "../shared/asr-catalog";
import { detectHighlights, chatComplete } from "@core/highlight/detect";
import { collectVisionSignal } from "@core/highlight/vision";
import { collectEmotionSignal } from "@core/emotion";
import { collectClipSegments, translateSegments, clipTranslationLines } from "@core/translate";
import { generatePublishCopies } from "@core/publish";
import { FolderWatcher, isVideoFile, isSeen, type SeenMap, type WatchedFile } from "@core/watch";
import { collectDanmakuSignal } from "@core/danmaku";
import { checkForUpdate } from "@core/update-check";
import { autoClip } from "@core/pipeline";
import { collectSignals } from "@core/signals";
import { exportClips, sanitizeFilename } from "@core/export";
import { sliceWords } from "@core/subtitle";
import { snapContextAround } from "@core/shots";
import { renderCaptionOverlay } from "./overlay-renderer";
import type { Transcript, LlmConfig, HighlightCandidate, ExportOptions, VisionStats, EmotionStats, DanmakuStats, WatchEvent, UpdateInfo } from "../shared/api-types";

const VIDEO_EXTENSIONS = ["mp4", "mkv", "mov", "flv", "ts", "webm", "avi", "m4v"];
const AUDIO_EXTENSIONS = ["mp3", "m4a", "wav", "aac", "flac"];

// ---- 本地媒体预览协议(审阅台) ----
// 渲染层的 <video> 通过 hotclip-media:// 流式读取源文件;必须在 app ready
// 前注册特权,才能拿到 fetch/流/Range 能力(拖进度条依赖 206 分段响应)。
protocol.registerSchemesAsPrivileged([
  { scheme: "hotclip-media", privileges: { stream: true, supportFetchAPI: true } },
]);

// 只放行本会话里 probe 成功过的文件——协议不做任意路径读取
const allowedMedia = new Set<string>();

const MEDIA_MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  webm: "video/webm",
  ts: "video/mp2t",
  avi: "video/x-msvideo",
  flv: "video/x-flv",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  aac: "audio/aac",
  flac: "audio/flac",
};

/** hotclip-media://local/<encodeURIComponent(路径)> → 带 Range 的文件流响应。 */
async function serveMedia(request: Request): Promise<Response> {
  const filePath = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, ""));
  if (!allowedMedia.has(filePath)) return new Response("forbidden", { status: 403 });
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch {
    return new Response("not found", { status: 404 });
  }
  const range = resolveByteRange(request.headers.get("range"), size);
  if (!range) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }
  const headers: Record<string, string> = {
    "Content-Type": MEDIA_MIME[extname(filePath).slice(1).toLowerCase()] ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Content-Length": String(range.end - range.start + 1),
  };
  if (range.status === 206) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
  const body = Readable.toWeb(
    createReadStream(filePath, { start: range.start, end: range.end })
  ) as unknown as ReadableStream;
  return new Response(body, { status: range.status, headers });
}

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

// 录播监听的目录选择
ipcMain.handle("hotclip:select-dir", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// 水印 logo 选择(品牌预设)
ipcMain.handle("hotclip:select-image", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp"] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle("hotclip:probe-media", async (_event, filePath: unknown) => {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new Error("probe-media requires a file path");
  }
  const info = await probeMedia(filePath);
  allowedMedia.add(filePath); // probe 成功的文件才可被预览协议读取
  return info;
});

// ---- IPC: 审阅台波形(上下文窗口的音频峰值) ----

ipcMain.handle("hotclip:audio-peaks", async (_event, filePath: unknown, startSec: unknown, endSec: unknown) => {
  if (typeof filePath !== "string" || !filePath.trim()) throw new Error("audio-peaks requires a file path");
  const from = typeof startSec === "number" && Number.isFinite(startSec) ? Math.max(0, startSec) : 0;
  const to = typeof endSec === "number" && Number.isFinite(endSec) ? endSec : 0;
  if (to <= from) throw new Error("audio-peaks requires a valid range");
  // 窗口封顶 10 分钟,防误传超大区间把内存打爆
  const track = await extractPeaks(filePath, from, Math.min(to, from + 600));
  return { values: Array.from(track.values), startSec: track.startSec, hopSec: track.hopSec };
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
  async (_event, transcript: unknown, llm: unknown, filePath: unknown, diarize: unknown, prefilter: unknown, vision: unknown, length: unknown) => {
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
    // 两级漏斗第一级(可选):本地小模型初筛;字段不合法直接不启用
    const pf = prefilter as { baseUrl?: unknown; model?: unknown } | null | undefined;
    const localFilter =
      pf && typeof pf.baseUrl === "string" && pf.baseUrl.trim() && typeof pf.model === "string" && pf.model.trim()
        ? { baseUrl: pf.baseUrl, model: pf.model }
        : null;
    // 画面侧信号(并发采集,各自 fail-open——失败/证据太薄都退回纯文本检测):
    // - 表情峰值:YuNet+FER+ 零配置自动跑(有画面就看,首次自动下载小模型);
    // - 视觉爆点:端侧 VL 抽帧(可选,需用户配置 Ollama 视觉模型)。
    let visionStats: VisionStats | undefined;
    let emotionStats: EmotionStats | undefined;
    let danmakuStats: DanmakuStats | undefined;
    if (typeof filePath === "string" && filePath.trim()) {
      const media = await probeMedia(filePath).catch(() => null);
      // 弹幕热度(零配置):视频旁同名 .xml(录播姬约定)自动发现,纯音频也适用
      if (media && media.durationSec > 1) {
        const dm = await collectDanmakuSignal(filePath, media.durationSec);
        if (dm) {
          signals = { loudPeaks: [], cutDense: [], ...signals, danmakuPeaks: dm.danmakuPeaks };
          danmakuStats = dm.stats;
        }
      }
      if (media && media.hasVideo && media.durationSec > 1) {
        const vc = vision as { baseUrl?: unknown; model?: unknown } | null | undefined;
        const visionCfg =
          vc && typeof vc.baseUrl === "string" && vc.baseUrl.trim() && typeof vc.model === "string" && vc.model.trim()
            ? { baseUrl: vc.baseUrl, model: vc.model }
            : null;
        const [emotionOutcome, visionOutcome] = await Promise.all([
          Promise.race([
            collectEmotionSignal({ videoPath: filePath, durationSec: media.durationSec, modelsRoot: modelsRoot(), signals }),
            new Promise<null>((r) => setTimeout(() => r(null), 120_000)),
          ]).catch(() => null),
          visionCfg
            ? collectVisionSignal({ videoPath: filePath, durationSec: media.durationSec, config: visionCfg, signals }).catch(() => null)
            : Promise.resolve(null),
        ]);
        if (emotionOutcome || visionOutcome) {
          signals = {
            loudPeaks: [],
            cutDense: [],
            ...signals,
            ...(visionOutcome ? { visualPeaks: visionOutcome.visualPeaks } : {}),
            ...(emotionOutcome ? { emotionPeaks: emotionOutcome.emotionPeaks } : {}),
          };
          visionStats = visionOutcome?.stats;
          emotionStats = emotionOutcome?.stats;
        }
      }
    }
    // 时长档:非法值回落标准档
    const clipLength =
      length === "short" || length === "long" || length === "standard" ? length : undefined;
    const outcome = await detectHighlights(t, config, undefined, signals, localFilter, clipLength);
    return { candidates: outcome.candidates, transcript: labeled, funnel: outcome.funnel, vision: visionStats, emotion: emotionStats, danmaku: danmakuStats };
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
  // 镜头吸附的外扩守卫:片外紧邻词的时刻(有转写才算得出;没有则 undefined,
  // 吸附退化为「只信片内词」的保守模式)
  const allWords = opts.transcript
    ? opts.transcript.segments.flatMap((s) => s.words).sort((a, b) => a.startSec - b.startSec)
    : null;
  // 双语字幕:导出前把所有选中切片覆盖的整句一次性批量翻译好(fail-open——
  // 翻译失败/端点不可用只是没有译文轨,绝不拖垮导出)。
  let translations: Map<number, string> | null = null;
  let translatable: ReturnType<typeof collectClipSegments> = [];
  const tr = opts.translate;
  if (
    tr && typeof tr.targetLang === "string" && tr.targetLang.trim() &&
    tr.llm?.baseUrl && tr.llm?.model && opts.transcript
  ) {
    translatable = collectClipSegments(opts.transcript, list);
    translations = await translateSegments(translatable, tr.targetLang, tr.llm, chatComplete).catch(() => null);
  }
  // 发布文案(可选):一次 LLM 批量为所有切片生成标题+话题+简介(fail-open)。
  let publishCopies: Map<number, import("@core/publish").PublishCopy> | null = null;
  const pub = opts.publishCopy;
  if (pub?.llm?.baseUrl && pub.llm.model) {
    const zh = !(opts.transcript?.language ?? "zh").startsWith("en");
    const sources = list.map((c) => ({ id: c.id, title: c.title, hook: c.hook, text: c.text, keywords: c.keywords }));
    publishCopies = await generatePublishCopies(sources, zh, pub.llm, chatComplete).catch(() => null);
  }
  return exportClips(
    filePath,
    list.map((c) => ({
      id: c.id,
      title: c.title,
      startSec: c.startSec,
      endSec: c.endSec,
      snapContext: allWords ? snapContextAround(allWords, c.startSec, c.endSec) : undefined,
      manualBounds: c.manualBounds === true,
      words: needWords ? sliceWords(opts.transcript!, c.startSec, c.endSec) : undefined,
      // 多留 1.5s 余量:导出时镜头吸附最多外扩 0.8s,夹取在 export 里做
      translation: translations
        ? clipTranslationLines(translatable, translations, c.startSec - 1.5, c.endSec + 1.5)
        : undefined,
      publish: publishCopies?.get(c.id),
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
      openingHook: Boolean(opts.openingHook),
      normalizeLoudness: Boolean(opts.normalizeLoudness),
      faceTrack: true,
      snapToShots: true,
      brand: sanitizeBrand(opts.brand),
      translateLang: translations ? opts.translate!.targetLang : undefined,
      subtitleFile: Boolean(opts.subtitleFile),
      timeline: Boolean(opts.timeline),
      aigcLabel: Boolean(opts.aigcLabel),
      modelsRoot: modelsRoot(),
      fontsDir,
      renderOverlay: renderCaptionOverlay,
    },
    (p) => {
      if (!event.sender.isDestroyed()) event.sender.send("hotclip:export-progress", p);
    }
  );
});

// ---- 录播监听:watch 文件夹,新录播写完落稳后自动全托管切片 ----
// 轮询式监听(网络盘/分段写盘下 fs.watch 不可靠);已处理记录持久化,重启不重切。

const WATCH_POLL_MS = 15_000;
let watchTimer: NodeJS.Timeout | null = null;
let watchDirPath: string | null = null;

const watchSeenPath = (): string => join(app.getPath("userData"), "watch-seen.json");

async function loadWatchSeen(): Promise<SeenMap> {
  try {
    return JSON.parse(await readFile(watchSeenPath(), "utf8")) as SeenMap;
  } catch {
    return {};
  }
}

ipcMain.handle("hotclip:watch-start", async (event, dir: unknown, llm: unknown) => {
  if (typeof dir !== "string" || !dir.trim()) throw new Error("watch requires a directory");
  const config = llm as LlmConfig;
  if (!config?.baseUrl || !config?.model) throw new Error("请先在设置里配置 LLM(baseUrl/model)");
  if (watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
  const seen = await loadWatchSeen();
  const emit = (e: Omit<WatchEvent, "at">): void => {
    if (!event.sender.isDestroyed()) event.sender.send("hotclip:watch-event", { ...e, at: Date.now() });
  };
  const fontsDir = app.isPackaged
    ? join(process.resourcesPath, "fonts")
    : join(app.getAppPath(), "resources", "fonts");
  const watcher = new FolderWatcher({
    listDir: async () => {
      const names = await readdir(dir);
      const files: WatchedFile[] = [];
      for (const name of names.filter(isVideoFile)) {
        const p = join(dir, name);
        const s = await stat(p).catch(() => null);
        if (s?.isFile()) files.push({ path: p, size: s.size, mtimeMs: s.mtimeMs });
      }
      return files;
    },
    isSeen: (f) => isSeen(seen, f),
    onStable: async (f) => {
      const file = basename(f.path);
      emit({ type: "found", file, path: f.path });
      // 成败都记 seen:失败重试要用户手动触发,不能无人值守下反复烧 LLM 花费
      const markSeen = async (): Promise<void> => {
        seen[f.path] = { size: f.size, mtimeMs: f.mtimeMs };
        await writeFile(watchSeenPath(), JSON.stringify(seen), "utf8").catch(() => {});
      };
      try {
        const outcome = await autoClip(f.path, {
          modelsRoot: modelsRoot(),
          cacheDir: transcriptCacheDir(),
          llm: config,
          fontsDir,
          onStage: (stage) => emit({ type: stage, file, path: f.path }),
        });
        await markSeen();
        emit({ type: "done", file, path: f.path, clips: outcome.exported.length, outDir: outcome.outDir });
      } catch (e) {
        await markSeen();
        emit({ type: "error", file, path: f.path, message: e instanceof Error ? e.message : String(e) });
      }
    },
  });
  watchDirPath = dir;
  watchTimer = setInterval(() => void watcher.tick(), WATCH_POLL_MS);
  void watcher.tick();
});

ipcMain.handle("hotclip:watch-stop", async () => {
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = null;
  watchDirPath = null;
});

ipcMain.handle("hotclip:watch-status", async () => ({ running: watchTimer !== null, dir: watchDirPath }));

// ---- 新版本检查:启动后渲染层问一次,失败静默 ----
let updateCache: UpdateInfo | null | undefined;
ipcMain.handle("hotclip:check-update", async () => {
  if (updateCache !== undefined) return updateCache;
  updateCache = await checkForUpdate(app.getVersion());
  return updateCache;
});

// 外链只放行本项目 GitHub(防任意 URL 注入系统浏览器)
ipcMain.on("hotclip:open-url", (_event, url: unknown) => {
  if (typeof url === "string" && url.startsWith("https://github.com/xixihhhh/hotclip")) {
    void shell.openExternal(url);
  }
});

ipcMain.on("hotclip:reveal", (_event, path: unknown) => {
  if (typeof path === "string" && path.trim()) shell.showItemInFolder(path);
});

app.whenReady().then(() => {
  protocol.handle("hotclip-media", serveMedia);
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
