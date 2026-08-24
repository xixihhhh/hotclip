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
import { createClipAligner } from "@core/align";
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
import { listModels } from "@core/llm-models";
import { collectVisionSignal } from "@core/highlight/vision";
import { reviewCandidatesVision } from "@core/highlight/review-vision";
import { composeContactSheetJpeg } from "@core/contact-sheet";
import { collectEmotionSignal } from "@core/emotion";
import { collectClipSegments, translateSegments, clipTranslationLines } from "@core/translate";
import { generatePublishCopies } from "@core/publish";
import { generateVariantPlans, expandClipSpecs, VARIANT_TOTAL_MAX } from "@core/variants";
import { generateAiBgm } from "@core/bgm-ai";
import { validPlatformIds } from "../shared/platform-specs";
import { FolderWatcher, isVideoFile, isSeen, type SeenMap, type WatchedFile } from "@core/watch";
import { startWebhookServer, type WebhookServerHandle } from "@core/webhook";
import { collectDanmakuSignal, readDanmakuItems, danmakuHeatCurve } from "@core/danmaku";
import { loudnessCurve } from "@core/signals";
import { extractFilmstrip } from "@core/filmstrip";
import { collectVoiceEmotionSignal } from "@core/voice-emotion";
import { checkForUpdate } from "@core/update-check";
import { clipOutDir } from "@core/appenv";
import { defaultModelsRoot, readAppSettings, resolveModelsRoot, writeAppSettings } from "@core/app-settings";
import { inspectModels, moveModelsDir } from "@core/models-inventory";
import { loadGlossary, saveGlossary } from "@core/glossary-store";
import { loadReviewMemory, recordReview, type ReviewedCandidate } from "@core/review-memory";
import {
  clearPerformanceMemory,
  importPerformanceFile,
  loadPerformanceMemory,
  summarizePerformance,
} from "@core/performance-memory";
import { importMediaUrl as downloadMediaUrl } from "@core/url-import";
import { applyGlossaryToTranscript } from "../shared/glossary";
import { tagTranscribeError } from "../shared/transcribe-errors";
import { autoClip, analyzeReferenceVideo } from "@core/pipeline";
import type { ReferenceProfile } from "@core/reference";
import { collectSignals } from "@core/signals";
import { exportClips, sanitizeFilename } from "@core/export";
import { sliceWords } from "@core/subtitle";
import { wordsInPieces } from "../shared/pieces";
import { snapContextAround } from "@core/shots";
import { renderCaptionOverlay } from "./overlay-renderer";
import { QUALITY_CRF } from "../shared/api-types";
import type { Transcript, TranscriptWord, LlmConfig, HighlightCandidate, ExportOptions, VisionStats, EmotionStats, DanmakuStats, VoiceTagStats, WatchEvent, UpdateInfo } from "../shared/api-types";

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

let urlImportAbort: AbortController | null = null;

ipcMain.handle("hotclip:import-media-url", async (event, url: unknown) => {
  if (typeof url !== "string") throw new Error("import-media-url requires a URL");
  if (urlImportAbort) throw new Error("A URL import is already running");
  const controller = new AbortController();
  urlImportAbort = controller;
  try {
    return await downloadMediaUrl(url, {
      toolsDir: join(app.getPath("userData"), "tools", "yt-dlp"),
      destDir: join(app.getPath("videos"), "HotClip", "Imports"),
      signal: controller.signal,
      onProgress: (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send("hotclip:url-import-progress", progress);
      },
    });
  } finally {
    if (urlImportAbort === controller) urlImportAbort = null;
  }
});

ipcMain.on("hotclip:url-import-cancel", () => {
  urlImportAbort?.abort();
});

// ---- IPC:真实发布表现反馈(设置中心) ----

ipcMain.handle("hotclip:performance-get", async () =>
  summarizePerformance(await loadPerformanceMemory(app.getPath("userData")))
);

ipcMain.handle("hotclip:performance-import", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [
      { name: "Platform metrics", extensions: ["csv", "json"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const imported = await importPerformanceFile(app.getPath("userData"), result.filePaths[0]);
  return { imported: imported.imported, skipped: imported.skipped, total: imported.total };
});

ipcMain.handle("hotclip:performance-clear", async () =>
  clearPerformanceMemory(app.getPath("userData"))
);

// 出厂导出根目录:~/影片/HotClip——新手在文件管理器里找得到(issue #3)
ipcMain.handle("hotclip:default-out-dir", async () => join(app.getPath("videos"), "HotClip"));

// ---- IPC: 模型存放位置(设置页)——1GB 的东西放哪儿,用户有权知道和决定 ----

ipcMain.handle("hotclip:models-info", async () =>
  inspectModels(modelsRoot(), defaultModelsRoot(app.getPath("userData")))
);

ipcMain.handle("hotclip:models-move", async (_event, dir: unknown) => {
  if (typeof dir !== "string" || !dir.trim()) throw new Error("move requires a directory");
  const userData = app.getPath("userData");
  const target = dir.trim();
  const landed = await moveModelsDir(modelsRoot(), target);
  // 搬成了才落配置:写早了会指向一个还没搬过去的空目录,模型全被判为「未安装」
  const isDefault = landed === defaultModelsRoot(userData);
  writeAppSettings(userData, { ...readAppSettings(userData), modelsDir: isDefault ? undefined : landed });
  return landed;
});

// 在文件管理器里打开目录(设置页的「打开文件夹」);不存在时静默,别弹系统错误框
ipcMain.on("hotclip:open-folder", (_event, dir: unknown) => {
  if (typeof dir === "string" && dir.trim()) void shell.openPath(dir);
});

// 录播监听的目录选择
ipcMain.handle("hotclip:select-dir", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// BGM 文件选择(声音设计)
ipcMain.handle("hotclip:select-audio", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "Audio", extensions: ["mp3", "m4a", "aac", "wav", "flac", "ogg"] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// AI 生成版权安全 BGM(v0.14 云端档):按品类风格生成纯音乐,存 userData
// 复用;生成完由渲染层把路径设进 bgmPath,走既有混音链
ipcMain.handle("hotclip:generate-bgm", async (_event, config: unknown, genreId: unknown) => {
  const llm = (config ?? {}) as LlmConfig;
  return await generateAiBgm({
    genreId: typeof genreId === "string" && genreId.trim() ? genreId : undefined,
    baseUrl: typeof llm.baseUrl === "string" ? llm.baseUrl : "",
    apiKey: typeof llm.apiKey === "string" ? llm.apiKey : "",
    destDir: join(app.getPath("userData"), "ai-bgm"),
  });
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

// ---- IPC: 工作台时间轴数据(全场响度/弹幕热度曲线 + 缩略图胶片带) ----
// 响度复用 warmSignals 缓存的 ebur128 采样(转写期已并行采过,不再解码一遍);
// 弹幕读视频旁的弹幕文件;缩略图串行抽 8 帧。各路 fail-open。

const timelineCache = new Map<string, Promise<import("../shared/api-types").TimelineData>>();

ipcMain.handle("hotclip:timeline-data", async (_event, filePath: unknown, durationSec: unknown) => {
  if (typeof filePath !== "string" || !filePath.trim()) throw new Error("timeline-data requires a file path");
  const dur = typeof durationSec === "number" && Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  if (dur <= 0) throw new Error("timeline-data requires a duration");
  const key = `${filePath}|${Math.round(dur)}`;
  let p = timelineCache.get(key);
  if (!p) {
    p = (async () => {
      const bins = Math.min(720, Math.max(120, Math.round(dur / 5)));
      const [signals, items, thumbs] = await Promise.all([
        warmSignals(filePath),
        readDanmakuItems(filePath).catch(() => null),
        extractFilmstrip(filePath, dur, 8).catch(() => [] as string[]),
      ]);
      return {
        loudness: signals?.loudnessSamples ? loudnessCurve(signals.loudnessSamples, dur, bins) : [],
        danmaku: items ? danmakuHeatCurve(items, dur, bins) : [],
        thumbs,
        binSec: dur / bins,
      };
    })();
    timelineCache.set(key, p);
    if (timelineCache.size > 4) {
      const first = timelineCache.keys().next().value;
      if (first !== undefined) timelineCache.delete(first);
    }
  }
  return p;
});

// ---- IPC: 候选片段接触表(审阅台画面速览,复用 VLM 同款拼图) ----

ipcMain.handle("hotclip:contact-sheet", async (_event, filePath: unknown, startSec: unknown, endSec: unknown) => {
  if (typeof filePath !== "string" || !filePath.trim()) throw new Error("contact-sheet requires a file path");
  const from = typeof startSec === "number" && Number.isFinite(startSec) ? Math.max(0, startSec) : 0;
  const to = typeof endSec === "number" && Number.isFinite(endSec) ? endSec : 0;
  if (to <= from) throw new Error("contact-sheet requires a valid range");
  // 片内均匀取 9 帧,首尾各让出一点(边界帧常是转场半帧)
  const span = to - from;
  const pad = Math.min(0.3, span / 10);
  const usable = span - pad * 2;
  const times = Array.from({ length: 9 }, (_, i) => from + pad + (usable * (i + 0.5)) / 9);
  const fontFile = app.isPackaged
    ? join(process.resourcesPath, "fonts", "SourceHanSansSC-Bold.otf")
    : join(app.getAppPath(), "resources", "fonts", "SourceHanSansSC-Bold.otf");
  const b64 = await composeContactSheetJpeg(filePath, times, { fontFile }).catch(() => null);
  return b64 ? `data:image/jpeg;base64,${b64}` : "";
});

// ---- IPC: 问 LLM 端点要模型清单 ----
// 模型 id 会随厂商换代失效,写死的预设迟早 404;让用户一键拉真实清单。
// listModels 自身 fail-open(返回 error 不抛),这里照原样透传给渲染进程。

ipcMain.handle("hotclip:llm-models", async (_event, baseUrl: unknown, apiKey: unknown) => {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    return { ids: [], error: "缺少 base_url / missing base_url" };
  }
  return listModels(baseUrl.trim(), typeof apiKey === "string" ? apiKey : "");
});

// ---- IPC: 审阅反馈回流(导出时记录采用/否决,下次检测注入偏好) ----

ipcMain.handle("hotclip:review-record", async (_event, video: unknown, kept: unknown, rejected: unknown) => {
  // 白名单清洗:渲染进程数据只取偏好档需要的字段并限长
  const clean = (list: unknown): ReviewedCandidate[] =>
    Array.isArray(list)
      ? list
          .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
          .slice(0, 24)
          .map((c) => ({
            title: String(c.title ?? "").slice(0, 80),
            hook: String(c.hook ?? "").slice(0, 120),
            score: Number.isFinite(Number(c.score)) ? Number(c.score) : 0,
            durationSec: Math.max(0, Math.round(Number(c.durationSec) || 0)),
            keywords: Array.isArray(c.keywords)
              ? c.keywords.filter((k): k is string => typeof k === "string" && k.trim().length > 0).slice(0, 5)
              : undefined,
          }))
          .filter((c) => c.title)
      : [];
  const k = clean(kept);
  const r = clean(rejected);
  if (k.length === 0 && r.length === 0) return;
  await recordReview(app.getPath("userData"), {
    at: new Date().toISOString(),
    video: typeof video === "string" ? basename(video) : "",
    kept: k,
    rejected: r,
  });
});

// ---- IPC: transcription (wizard step 2) ----
// Engine instances are cheap; models are downloaded once into userData.

// 模型位置用户可改(设置页),每次现读配置——搬完家后续下载立刻落新位置
const modelsRoot = (): string => resolveModelsRoot(app.getPath("userData"));
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
    // 缓存永远存 ASR 原始结果,词表在返回侧应用——词表更新后同素材
    // 重放替换即可生效,不重跑 ASR
    const glossary = await loadGlossary(app.getPath("userData"));
    if (fileStat) {
      const cached = await readTranscriptCache(transcriptCacheDir(), filePath, fileStat, resolvedEngineId);
      if (cached) return applyGlossaryToTranscript(cached, glossary).transcript;
    }
    // cloud engines take the user's key for this one call — never persisted here
    const engine =
      resolvedEngineId === "elevenlabs"
        ? new ElevenLabsEngine(typeof apiKey === "string" ? apiKey : "")
        : ASR_ENGINES[resolvedEngineId as keyof typeof ASR_ENGINES].make();
    let result: Transcript;
    try {
      result = await engine.transcribe(filePath, {
        onProgress: (p) => {
          // renderer may already be gone on quit — guard the send
          if (!event.sender.isDestroyed()) event.sender.send("hotclip:transcribe-progress", p);
        },
      });
    } catch (e) {
      // 失败后补一次探测,把「素材真没音轨」从模型下载/解压/解码失败里
      // 区分出来打标记——否则 UI 只能笼统提示,误导用户反复转码(issue #2)
      const raw = e instanceof Error ? e.message : String(e);
      const media = await probeMedia(filePath).catch(() => null);
      throw new Error(tagTranscribeError(raw, media));
    }
    if (fileStat && result?.segments?.length) {
      void writeTranscriptCache(transcriptCacheDir(), filePath, fileStat, resolvedEngineId, result);
    }
    return applyGlossaryToTranscript(result, glossary).transcript;
  } finally {
    transcribing = false;
  }
});

// ---- IPC: highlight detection (wizard step 2, after transcription) ----
// The LLM key comes from the renderer's settings; it is used for this one
// call and never persisted in the main process.

ipcMain.handle(
  "hotclip:detect-highlights",
  async (_event, transcript: unknown, llm: unknown, filePath: unknown, diarize: unknown, prefilter: unknown, vision: unknown, length: unknown, products: unknown, referencePath: unknown, genre: unknown, brief: unknown, scan: unknown) => {
    let t = transcript as Transcript;
    const config = llm as LlmConfig;
    if (!t || !Array.isArray(t.segments)) throw new Error("detect-highlights requires a transcript");
    if (!config?.baseUrl || !config?.model) throw new Error("请先在设置里配置 LLM(baseUrl/model)");
    // 参考爆款画像(可选):用户显式给的输入,分析失败按无参考继续,
    // 但失败原因必须随结果带回给 UI——不静默丢
    let reference: ReferenceProfile | undefined;
    let referenceError: string | undefined;
    if (typeof referencePath === "string" && referencePath.trim()) {
      try {
        reference = await analyzeReferenceVideo(referencePath, {
          modelsRoot: modelsRoot(),
          cacheDir: transcriptCacheDir(),
          glossary: await loadGlossary(app.getPath("userData")),
        });
      } catch (e) {
        referenceError = e instanceof Error ? e.message : String(e);
      }
    }
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
    // 候选段画面复核用的视觉端点(与信号通道同一配置;hasVideo 时才会被赋值)
    let reviewVisionCfg: { baseUrl: string; model: string; apiKey?: string } | null = null;
    let emotionStats: EmotionStats | undefined;
    let danmakuStats: DanmakuStats | undefined;
    let voiceStats: VoiceTagStats | undefined;
    let voicePending: Promise<Awaited<ReturnType<typeof collectVoiceEmotionSignal>>> = Promise.resolve(null);
    if (typeof filePath === "string" && filePath.trim()) {
      const media = await probeMedia(filePath).catch(() => null);
      // 弹幕热度(零配置):视频旁同名 .xml(录播姬约定)自动发现,纯音频也适用
      if (media && media.durationSec > 1) {
        const dm = await collectDanmakuSignal(filePath, media.durationSec);
        if (dm) {
          signals = { loudPeaks: [], cutDense: [], ...signals, danmakuPeaks: dm.danmakuPeaks };
          danmakuStats = dm.stats;
        }
        // 语音情绪/笑声掌声(零配置,复用已装的 SenseVoice 权重):纯音频素材也适用,
        // 与画面侧信号并发跑——它只吃 CPU 解码,不和抽帧抢 ffmpeg
        voicePending = Promise.race([
          collectVoiceEmotionSignal({
            videoPath: filePath,
            durationSec: media.durationSec,
            modelsRoot: modelsRoot(),
            signals,
          }),
          new Promise<null>((r) => setTimeout(() => r(null), 120_000)),
        ]).catch(() => null);
      }
      if (media && media.hasVideo && media.durationSec > 1) {
        const vc = vision as { baseUrl?: unknown; model?: unknown; apiKey?: unknown } | null | undefined;
        const visionCfg =
          vc && typeof vc.baseUrl === "string" && vc.baseUrl.trim() && typeof vc.model === "string" && vc.model.trim()
            ? { baseUrl: vc.baseUrl, model: vc.model, apiKey: typeof vc.apiKey === "string" && vc.apiKey.trim() ? vc.apiKey : undefined }
            : null;
        reviewVisionCfg = visionCfg;
        const [emotionOutcome, visionOutcome] = await Promise.all([
          Promise.race([
            collectEmotionSignal({ videoPath: filePath, durationSec: media.durationSec, modelsRoot: modelsRoot(), signals }),
            new Promise<null>((r) => setTimeout(() => r(null), 120_000)),
          ]).catch(() => null),
          visionCfg
            ? collectVisionSignal({
                videoPath: filePath,
                durationSec: media.durationSec,
                config: visionCfg,
                signals,
                // 全场扫描档(v0.13):用户显式开启才跑(费时;云端按量计费)
                scan: scan === true,
                // 接触表九宫格的序号标注字体(与字幕同一捆绑字体)
                fontFile: app.isPackaged
                  ? join(process.resourcesPath, "fonts", "SourceHanSansSC-Bold.otf")
                  : join(app.getAppPath(), "resources", "fonts", "SourceHanSansSC-Bold.otf"),
              }).catch(() => null)
            : Promise.resolve(null),
        ]);
        if (emotionOutcome || visionOutcome) {
          signals = {
            loudPeaks: [],
            cutDense: [],
            ...signals,
            ...(visionOutcome ? { visualPeaks: visionOutcome.visualPeaks } : {}),
            // 画面时刻线(全场扫描档):画面描述回流选段证据
            ...(visionOutcome && visionOutcome.visualNotes.length > 0 ? { visualNotes: visionOutcome.visualNotes } : {}),
            ...(emotionOutcome ? { emotionPeaks: emotionOutcome.emotionPeaks } : {}),
          };
          visionStats = visionOutcome?.stats;
          emotionStats = emotionOutcome?.stats;
        }
      }
      const voiceOutcome = await voicePending;
      if (voiceOutcome && (voiceOutcome.voiceEmotionPeaks.length > 0 || voiceOutcome.audioEventPeaks.length > 0)) {
        signals = {
          loudPeaks: [],
          cutDense: [],
          ...signals,
          voiceEmotionPeaks: voiceOutcome.voiceEmotionPeaks,
          audioEventPeaks: voiceOutcome.audioEventPeaks,
        };
        voiceStats = voiceOutcome.stats;
      }
    }
    // 时长档:非法值回落标准档
    const clipLength =
      length === "short" || length === "long" || length === "standard" ? length : undefined;
    // 商品词:白名单清洗(字符串数组,单词 ≤30 字,最多 20 个)
    const productWords = Array.isArray(products)
      ? products.filter((p): p is string => typeof p === "string" && p.trim().length > 0).map((p) => p.trim().slice(0, 30)).slice(0, 20)
      : [];
    // 审阅偏好回流:本机历史采用/否决样例进提示词(空记忆无感)
    const reviewMemory = await loadReviewMemory(app.getPath("userData"));
    const performanceMemory = await loadPerformanceMemory(app.getPath("userData"));
    // 品类判据:白名单清洗(id 必须是字符串,自定义文本截断由 core 侧兜)
    const g = genre as { id?: unknown; custom?: unknown } | null | undefined;
    const genreArg =
      g && (typeof g.id === "string" || typeof g.custom === "string")
        ? {
            id: typeof g.id === "string" ? g.id : undefined,
            custom: typeof g.custom === "string" ? g.custom : undefined,
          }
        : undefined;
    // 用户点题:白名单清洗(两段自由文本,截断由 core 侧 briefSection 兜)
    const b = brief as { focus?: unknown; exclude?: unknown } | null | undefined;
    const briefArg =
      b && ((typeof b.focus === "string" && b.focus.trim()) || (typeof b.exclude === "string" && b.exclude.trim()))
        ? {
            focus: typeof b.focus === "string" ? b.focus.trim() : undefined,
            exclude: typeof b.exclude === "string" ? b.exclude.trim() : undefined,
          }
        : undefined;
    const outcome = await detectHighlights(t, config, undefined, signals, localFilter, clipLength, productWords, reference, reviewMemory, genreArg, briefArg, performanceMemory);
    // 候选段画面复核(v0.12):每条候选一张接触表让 VL 看画面,画面分回流
    // 排序、看点进 reason。fail-open:失败/超时沿用原候选。
    let candidates = outcome.candidates;
    if (reviewVisionCfg && candidates.length > 0 && typeof filePath === "string") {
      const reviewed = await reviewCandidatesVision({
        videoPath: filePath,
        candidates,
        config: reviewVisionCfg,
        fontFile: app.isPackaged
          ? join(process.resourcesPath, "fonts", "SourceHanSansSC-Bold.otf")
          : join(app.getAppPath(), "resources", "fonts", "SourceHanSansSC-Bold.otf"),
      }).catch(() => null);
      if (reviewed) {
        candidates = reviewed.candidates;
        visionStats = {
          ...(visionStats ?? { framesTotal: 0, framesScored: 0, peakCount: 0 }),
          candidatesReviewed: reviewed.stats.reviewed,
          candidatesAdjusted: reviewed.stats.boosted + reviewed.stats.demoted,
        };
      }
    }
    return { candidates, transcript: labeled, funnel: outcome.funnel, vision: visionStats, emotion: emotionStats, danmaku: danmakuStats, voice: voiceStats, reference: reference ?? null, referenceError };
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
// Output goes to <导出根目录>/<source-name>/ — 出厂是 ~/Movies/HotClip,界面可改。

// 导出取消:单并发导出,一个活动控制器;cancel 会 kill 正在跑的 ffmpeg
let exportAbort: AbortController | null = null;
ipcMain.on("hotclip:export-cancel", () => exportAbort?.abort());

/** 一条候选实际要用的词表:拼接片只取落在各段内的词,单段照旧按区间取。 */
function clipWords(transcript: Transcript, c: HighlightCandidate): TranscriptWord[] {
  const words = sliceWords(transcript, c.startSec, c.endSec);
  return c.pieces && c.pieces.length > 1 ? wordsInPieces(words, c.pieces) : words;
}

ipcMain.handle("hotclip:export-clips", async (event, filePath: unknown, clips: unknown, options: unknown) => {
  if (typeof filePath !== "string" || !filePath.trim()) throw new Error("export requires a file path");
  const list = clips as HighlightCandidate[];
  if (!Array.isArray(list) || list.length === 0) throw new Error("no clips selected");
  const opts = (options ?? {}) as ExportOptions;
  const style =
    opts.captionStyle && opts.captionStyle !== "none" && opts.transcript ? opts.captionStyle : undefined;
  const jumpCut = Boolean(opts.jumpCut && opts.transcript);
  const cleanFillers = Boolean(opts.cleanFillers && opts.transcript);
  const cutRetakes = Boolean(opts.cutRetakes && opts.transcript);
  const needWords = Boolean(style) || jumpCut || cleanFillers || cutRetakes;
  const sourceName = sanitizeFilename(basename(filePath, extname(filePath)), "video");
  const outDir = clipOutDir(opts.outDir, app.getPath("videos"), sourceName);
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
  const zh = !(opts.transcript?.language ?? "zh").startsWith("en");
  // saveWorthy:实用密度达线的候选(v0.14),发布文案转收藏/搜索导向
  const copySources = list.map((c) => ({ id: c.id, title: c.title, hook: c.hook, text: c.text, keywords: c.keywords, saveWorthy: Boolean(c.utility) }));
  let publishCopies: Map<number, import("@core/publish").PublishCopy> | null = null;
  const pub = opts.publishCopy;
  if (pub?.llm?.baseUrl && pub.llm.model) {
    publishCopies = await generatePublishCopies(copySources, zh, pub.llm, chatComplete).catch(() => null);
  }
  // 一片多版(可选):一次 LLM 为整批切片生成差异化包装计划(fail-open——
  // 失败只是没有变体,原版照常导出)。
  let variantPlans: Map<number, import("@core/variants").VariantPackaging[]> | null = null;
  const varOpt = opts.variants;
  if (varOpt?.llm?.baseUrl && varOpt.llm.model && Number(varOpt.count) >= 2) {
    variantPlans = await generateVariantPlans(
      copySources,
      Math.min(Number(varOpt.count), VARIANT_TOTAL_MAX),
      zh,
      varOpt.llm,
      chatComplete
    ).catch(() => null);
  }
  exportAbort = new AbortController();
  const abortSignal = exportAbort.signal;
  // 精准切点:主转写不是 Paraformer 档时才有意义(它自己的 CIF 时间戳已是
  // 最优);对齐器整批复用一个,模型首次使用才下载(用户显式开了才发生)
  const alignWords =
    opts.preciseAlign && needWords && opts.transcript && opts.transcript.engine !== "paraformer-local"
      ? createClipAligner(modelsRoot(), abortSignal)
      : undefined;
  try {
  const baseSpecs = list.map((c) => ({
      id: c.id,
      title: c.title,
      startSec: c.startSec,
      endSec: c.endSec,
      // 多片段拼接:段清单原样带下去,段间空隙在 export 里当强制剪除区间处理
      pieces: Array.isArray(c.pieces) && c.pieces.length > 1 ? c.pieces : undefined,
      snapContext: allWords ? snapContextAround(allWords, c.startSec, c.endSec) : undefined,
      manualBounds: c.manualBounds === true,
      // 拼接片的词表只取真正剪进去的那几段——空隙里的词既不该上字幕,
      // 也不该参与跳剪/重录判定
      words: needWords ? clipWords(opts.transcript!, c) : undefined,
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
    }));
  return await exportClips(
    filePath,
    // 一片多版:变体克隆原 spec(换标题/悬念句/文案/封面峰),紧跟原版排列;
    // 全局爆点闪现没开时,最后一版再换开场结构(flash-forward 差异维度)
    variantPlans ? expandClipSpecs(baseSpecs, variantPlans, Boolean(pub?.llm?.baseUrl && pub.llm.model), !opts.flashForward) : baseSpecs,
    outDir,
    {
      vertical: Boolean(opts.vertical),
      captionStyle: style,
      jumpCut,
      // 保留呼吸口(v0.14):跳剪的剪口留一口气;只在跳剪开着时有意义
      keepBreath: Boolean(opts.keepBreath),
      // 说话人标签(v0.14):缺省开——词表没有说话人标注时自然不生效
      speakerLabels: opts.speakerLabels !== false,
      // 模板受控微扰(v0.14):批量出片反量产指纹,显式开启才抖
      templateJitter: Boolean(opts.templateJitter),
      cleanFillers,
      cutRetakes,
      autoZoom: Boolean(opts.autoZoom),
      // 音效/BGM/品类分档:声音设计层(见 core/sound-design.ts 与 genre.ts)
      sfx: Boolean(opts.sfx),
      bgmPath: typeof opts.bgmPath === "string" && opts.bgmPath.trim() ? opts.bgmPath : undefined,
      genreId: typeof opts.genreId === "string" ? opts.genreId : undefined,
      trimUi: Boolean(opts.trimUi),
      titleCard: Boolean(opts.titleCard),
      openingHook: Boolean(opts.openingHook),
      normalizeLoudness: Boolean(opts.normalizeLoudness),
      // 修复:这四个开关此前从未传进导出层——UI 点了没效果,被 fail-open
      // 语义掩盖(降噪/合集/横屏版/高潮前置在桌面端一直是死开关)
      denoise: Boolean(opts.denoise),
      compilation: Boolean(opts.compilation),
      coldOpen: Boolean(opts.coldOpen),
      alsoLandscape: Boolean(opts.alsoLandscape),
      // 爆点闪现(v0.12):情绪峰画面 0.3-1s 前置,视觉钩子
      flashForward: Boolean(opts.flashForward),
      // 精准切点(v0.12):Paraformer 二遍对齐修正词级时间戳
      alignWords,
      faceTrack: true,
      snapToShots: true,
      brand: sanitizeBrand(opts.brand),
      // 画质档只影响 CRF;不认的值回落 high,保持历史默认画质
      crf: QUALITY_CRF[opts.quality && opts.quality in QUALITY_CRF ? opts.quality : "high"],
      translateLang: translations ? opts.translate!.targetLang : undefined,
      subtitleFile: Boolean(opts.subtitleFile),
      timeline: Boolean(opts.timeline),
      // 剪映草稿(v0.14):AI 切点进剪映时间轴,国民级「粗剪→精修」通道
      jianyingDraft: Boolean(opts.jianyingDraft),
      aigcLabel: Boolean(opts.aigcLabel),
      // 留证包(v0.14):源片前后各 3 分钟流复制留档(授权审核新规)
      evidencePack: Boolean(opts.evidencePack),
      // AI 封面双档(v0.14):透传用户 LLM 档的 Atlas Key,导出层判端点可用性
      aiCover:
        opts.aiCover?.llm?.baseUrl && opts.aiCover.llm.apiKey && (opts.aiCover.tier === "volume" || opts.aiCover.tier === "premium")
          ? { tier: opts.aiCover.tier, baseUrl: opts.aiCover.llm.baseUrl, apiKey: opts.aiCover.llm.apiKey, zh }
          : undefined,
      // 平台发布包:未知平台 id 直接过滤(不猜),空清单等于没开
      publishPack: Array.isArray(opts.publishPack) ? validPlatformIds(opts.publishPack.filter((p): p is string => typeof p === "string")) : undefined,
      modelsRoot: modelsRoot(),
      fontsDir,
      renderOverlay: renderCaptionOverlay,
    },
    (p) => {
      if (!event.sender.isDestroyed()) event.sender.send("hotclip:export-progress", p);
    },
    abortSignal
  );
  } finally {
    exportAbort = null;
  }
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

/**
 * 一个录播文件的完整处理(转写→找爆点→导出),watch 文件夹与 webhook 共用。
 * 成败都记 seen:失败重试要用户手动触发,不能无人值守下反复烧 LLM 花费。
 */
function makeRecordingProcessor(
  seen: SeenMap,
  config: LlmConfig,
  outDir: unknown,
  emit: (e: Omit<WatchEvent, "at">) => void
): (f: WatchedFile) => Promise<void> {
  const fontsDir = app.isPackaged
    ? join(process.resourcesPath, "fonts")
    : join(app.getAppPath(), "resources", "fonts");
  return async (f: WatchedFile) => {
    const file = basename(f.path);
    emit({ type: "found", file, path: f.path });
    const markSeen = async (): Promise<void> => {
      seen[f.path] = { size: f.size, mtimeMs: f.mtimeMs };
      await writeFile(watchSeenPath(), JSON.stringify(seen), "utf8").catch(() => {});
    };
    try {
      const outcome = await autoClip(f.path, {
        // 用户自选过导出位置就照办;没选过保持老行为(成片落录播文件旁边)
        outDir:
          typeof outDir === "string" && outDir.trim()
            ? join(outDir.trim(), sanitizeFilename(basename(f.path, extname(f.path)), "video"))
            : undefined,
        modelsRoot: modelsRoot(),
        cacheDir: transcriptCacheDir(),
        llm: config,
        fontsDir,
        glossary: await loadGlossary(app.getPath("userData")),
        reviewMemory: await loadReviewMemory(app.getPath("userData")),
        performanceMemory: await loadPerformanceMemory(app.getPath("userData")),
        onStage: (stage) => emit({ type: stage, file, path: f.path }),
      });
      await markSeen();
      emit({ type: "done", file, path: f.path, clips: outcome.exported.length, outDir: outcome.outDir });
    } catch (e) {
      await markSeen();
      emit({ type: "error", file, path: f.path, message: e instanceof Error ? e.message : String(e) });
    }
  };
}

ipcMain.handle("hotclip:watch-start", async (event, dir: unknown, llm: unknown, outDir: unknown) => {
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
  const process = makeRecordingProcessor(seen, config, outDir, emit);
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
    onStable: process,
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

// ---- 录播 webhook:录播姬/blrec 下播回调即出片(比轮询更实时) ----
// 只绑回环;回调给的路径必须落在用户指定的录播目录内(外部输入不可信)。
let webhookHandle: WebhookServerHandle | null = null;
let webhookInfo: { port: number; dir: string } | null = null;
/** 串行队列:录播机同时只跑一条切片管线,不打爆 CPU(与 watch 的 drain 同思路)。 */
let webhookChain: Promise<void> = Promise.resolve();

ipcMain.handle(
  "hotclip:webhook-start",
  async (event, dir: unknown, llm: unknown, outDir: unknown, port: unknown, token: unknown) => {
    if (typeof dir !== "string" || !dir.trim()) throw new Error("webhook 需要指定录播目录");
    const config = llm as LlmConfig;
    if (!config?.baseUrl || !config?.model) throw new Error("请先在设置里配置 LLM(baseUrl/model)");
    const recDir = dir.trim();
    const s = await stat(recDir).catch(() => null);
    if (!s?.isDirectory()) throw new Error(`录播目录不存在: ${recDir}`);
    await webhookHandle?.close();
    webhookHandle = null;

    const seen = await loadWatchSeen();
    const emit = (e: Omit<WatchEvent, "at">): void => {
      if (!event.sender.isDestroyed()) event.sender.send("hotclip:watch-event", { ...e, at: Date.now() });
    };
    const process = makeRecordingProcessor(seen, config, outDir, emit);
    const wanted = Number(port);
    webhookHandle = await startWebhookServer({
      port: Number.isFinite(wanted) && wanted > 0 && wanted < 65536 ? Math.round(wanted) : 17650,
      token: typeof token === "string" && token.trim() ? token.trim() : undefined,
      workDir: recDir,
      onLog: (message) => emit({ type: "error", file: "webhook", path: recDir, message }),
      onRecording: (e) => {
        // 回调只说"写完了",文件是否真的可读由这里核实;重复回调靠 seen 挡掉
        webhookChain = webhookChain.then(async () => {
          const st = await stat(e.path).catch(() => null);
          if (!st?.isFile()) {
            emit({ type: "error", file: basename(e.path), path: e.path, message: "回调指向的文件不存在或不可读" });
            return;
          }
          const f: WatchedFile = { path: e.path, size: st.size, mtimeMs: st.mtimeMs };
          if (isSeen(seen, f)) return; // 同一文件的重复回调(写完 + 后处理完)
          await process(f);
        });
      },
    });
    webhookInfo = { port: webhookHandle.port, dir: recDir };
    return webhookInfo;
  }
);

ipcMain.handle("hotclip:webhook-stop", async () => {
  await webhookHandle?.close();
  webhookHandle = null;
  webhookInfo = null;
});

ipcMain.handle("hotclip:webhook-status", async () => ({
  running: webhookHandle !== null,
  port: webhookInfo?.port ?? null,
  dir: webhookInfo?.dir ?? null,
}));

// ---- 新版本检查:启动后渲染层问一次,失败静默 ----
let updateCache: UpdateInfo | null | undefined;
ipcMain.handle("hotclip:check-update", async () => {
  if (updateCache !== undefined) return updateCache;
  updateCache = await checkForUpdate(app.getVersion());
  return updateCache;
});

// ---- 热词词表:错词→对词,转写后自动应用(桌面/MCP/录播监听共用一份) ----
ipcMain.handle("hotclip:glossary-get", async () => loadGlossary(app.getPath("userData")));
ipcMain.handle("hotclip:glossary-set", async (_event, entries: unknown) => {
  await saveGlossary(app.getPath("userData"), Array.isArray(entries) ? entries : []);
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
