import { QwenLocalEngine } from "./transcribe/qwen-local";
import { ParaformerEngine } from "./transcribe/paraformer";
import { FireRedEngine } from "./transcribe/firered";
import type { SpeechRunOptions } from "../shared/api-types";
/**
 * 自动切片公共管线(无 UI 依赖):转写(带缓存)→ 信号采集 → LLM 找爆点 →
 * 导出推荐切片。MCP Server 与录播监听(watch 文件夹)共用同一条路径,
 * 与桌面端"一键全自动"产出保持一致。
 */
import { join, dirname, basename, extname } from "path";
import { stat } from "fs/promises";
import type { GlossaryEntry, LlmConfig, Transcript, HighlightCandidate } from "../shared/api-types";
import { applyGlossaryToTranscript } from "../shared/glossary";
import { SenseVoiceEngine } from "./transcribe/sensevoice";
import { importSubtitleFile } from "./subtitle-import";
import { readTranscriptCache, writeTranscriptCache } from "./transcribe/cache";
import { detectHighlights } from "./highlight/detect";
import { collectSignalsEvidence, detectShotBoundariesEvidence } from "./media-evidence";
import { buildReferenceProfile, type ReferenceProfile } from "./reference";
import type { ReviewRecord } from "./review-memory";
import type { PerformanceEntry } from "./performance-memory";
import { collectEmotionSignal } from "./emotion";
import { collectDanmakuSignal } from "./danmaku";
import { collectVoiceEmotionSignal } from "./voice-emotion";
import { exportClips, sanitizeFilename, type ExportedClip } from "./export";
import { sliceWords } from "./subtitle";
import { wordsInPieces } from "../shared/pieces";
import { probeMedia } from "./probe";
import { planColorRender } from "./color";
import type { AnalysisVideoOptions } from "./analysis-video";

export interface AutoClipConfig {
  modelsRoot: string;
  cacheDir: string;
  /** Explicit UTF-8 SRT/WebVTT transcript for this source; bypasses ASR/cache. */
  subtitlePath?: string;
  asr?: SpeechRunOptions & { engineId?: string };
  /** Reusable bounded base-render cache; omit to disable. */
  renderCacheDir?: string;
  /** Reusable bounded source-analysis evidence; omit to disable. */
  evidenceCacheDir?: string;
  llm: LlmConfig;
  /** 输出目录;缺省源视频旁 `<名>-hotclip/`。 */
  outDir?: string;
  /** 字幕字体目录(烧录 CJK 一致性)。 */
  fontsDir?: string;
  /** 热词词表(转写后自动应用;字幕/找爆点/文案全用修正后文本)。 */
  glossary?: GlossaryEntry[];
  maxClips?: number;
  vertical?: boolean;
  captions?: boolean;
  /** Opt-in local signalstats-based picture correction; neutral footage is untouched. */
  autoEnhance?: boolean;
  /** Optional audio cleanup for unattended/headless exports; omitted means unchanged/off. */
  denoiseMode?: "basic" | "smart";
  /** 参考爆款画像(analyzeReferenceVideo 的产物);选段向它的节奏靠拢。 */
  reference?: ReferenceProfile;
  /** 本机审阅记忆(桌面审阅台积累的采用/否决样例);选段向用户口味靠拢。 */
  reviewMemory?: ReviewRecord[];
  /** 真实发布表现记忆(CSV/JSON 导入);选段向观众验证过的模式靠拢。 */
  performanceMemory?: PerformanceEntry[];
  onStage?: (stage: "transcribing" | "detecting" | "exporting") => void;
  signal?: AbortSignal;
}

export interface AutoClipResult {
  outDir: string;
  transcript: Transcript;
  candidates: HighlightCandidate[];
  /** AI 复评后建议发布并成功导出的切片。 */
  exported: ExportedClip[];
}

/**
 * 端侧转写(SenseVoice,带缓存;首次自动下载模型)。缓存永远存 ASR 原始
 * 结果,词表在读取侧应用——词表更新后同素材重放替换即可,不重跑 ASR。
 */
export async function transcribeCached(
  videoPath: string,
  modelsRoot: string,
  cacheDir: string,
  glossary?: GlossaryEntry[],
  signal?: AbortSignal,
  subtitlePath?: string,
  asr: SpeechRunOptions & { engineId?: string } = {}
): Promise<Transcript> {
  signal?.throwIfAborted();
  // User-supplied text is authoritative, including on failure. Never silently
  // replace it with ASR or run ASR glossary corrections over reviewed subtitles.
  if (subtitlePath !== undefined) return importSubtitleFile(videoPath, subtitlePath, signal);
  const s = await stat(videoPath).catch(() => null);
  if (!s || !s.isFile()) throw new Error(`文件不存在或不可读: ${videoPath}`);
  const fileStat = { size: s.size, mtimeMs: s.mtimeMs };
  const applied = (t: Transcript): Transcript => applyGlossaryToTranscript(t, glossary ?? []).transcript;
  const engineId = asr.engineId ?? "sensevoice";
  if (!["sensevoice", "paraformer", "fireredasr", "qwen3"].includes(engineId)) throw new Error("Unknown local ASR engine");
  const cached = !asr.restart && engineId !== "qwen3" ? await readTranscriptCache(cacheDir, videoPath, fileStat, engineId) : undefined;
  if (cached) return applied(cached);
  const engine = engineId === "qwen3" ? new QwenLocalEngine(asr.localServiceUrl)
    : engineId === "paraformer" ? new ParaformerEngine(modelsRoot)
    : engineId === "fireredasr" ? new FireRedEngine(modelsRoot) : new SenseVoiceEngine(modelsRoot);
  const t = await engine.transcribe(videoPath, { ...asr, signal, cacheDir });
  if (engineId !== "qwen3") await writeTranscriptCache(cacheDir, videoPath, fileStat, engineId, t).catch(() => {});
  return applied(t);
}

/**
 * 分析参考爆款 → 风格画像:端侧转写(带缓存)+ 全片镜头检测。
 * 转写失败上抛(用户显式给的输入,静默丢弃是坑);镜头检测失败退 null 维度。
 */
export async function analyzeReferenceVideo(
  refPath: string,
  cfg: Pick<AutoClipConfig, "modelsRoot" | "cacheDir" | "evidenceCacheDir" | "glossary" | "signal">
): Promise<ReferenceProfile> {
  const transcript = await transcribeCached(refPath, cfg.modelsRoot, cfg.cacheDir, cfg.glossary, cfg.signal);
  const durationSec =
    transcript.durationSec > 0
      ? transcript.durationSec
      : transcript.segments[transcript.segments.length - 1]?.endSec ?? 0;
  const media = await probeMedia(refPath).catch(() => null);
  const analysis: AnalysisVideoOptions = media?.hasVideo
    ? { videoStreamIndex: media.videoStreamIndex, color: planColorRender(media) }
    : {};
  const boundaries = await detectShotBoundariesEvidence({
    videoPath: refPath,
    startSec: 0,
    endSec: durationSec,
    modelsRoot: cfg.modelsRoot,
    evidenceDir: cfg.evidenceCacheDir,
    signal: cfg.signal,
    analysis,
  }).catch(() => null);
  return buildReferenceProfile(transcript, boundaries);
}

/** 找爆点(与桌面端同款证据链:响度/镜头 + 表情峰值,全部 fail-open)。 */
export async function detectForPipeline(
  videoPath: string,
  transcript: Transcript,
  cfg: Pick<AutoClipConfig, "modelsRoot" | "evidenceCacheDir" | "llm" | "maxClips" | "reference" | "reviewMemory" | "performanceMemory" | "signal">
): Promise<HighlightCandidate[]> {
  if (transcript.segments.length === 0) throw new Error("转写结果为空(可能是无人声素材)");
  const media = await probeMedia(videoPath).catch(() => null);
  const analysis: AnalysisVideoOptions = media?.hasVideo
    ? { videoStreamIndex: media.videoStreamIndex, color: planColorRender(media) }
    : {};
  const signals = await collectSignalsEvidence({
    videoPath,
    evidenceDir: cfg.evidenceCacheDir,
    signal: cfg.signal,
    analysis,
  }).catch((error) => {
    if (cfg.signal?.aborted) throw error;
    return undefined;
  });
  // 弹幕热度(零配置):录播姬随录播落的同名 .xml 自动发现——录播监听场景的
  // 主证据。它只是读个文件,先于贵信号采集:弹幕峰值(观众逐秒投的票)要
  // 参与引导表情/语音情绪的采样预算,笑声和表情最该去观众炸锅的地方找
  const danmaku = await collectDanmakuSignal(videoPath, transcript.durationSec);
  const guided = danmaku
    ? { loudPeaks: [], cutDense: [], ...signals, danmakuPeaks: danmaku.danmakuPeaks }
    : signals;
  const emotion = await collectEmotionSignal({
    videoPath,
    durationSec: transcript.durationSec,
    modelsRoot: cfg.modelsRoot,
    signals: guided,
    analysis,
  }).catch(() => null);
  // 语音情绪/笑声掌声(零配置,复用已装的 SenseVoice 权重):文字稿看不见的那半条证据
  const voice = await collectVoiceEmotionSignal({
    videoPath,
    durationSec: transcript.durationSec,
    modelsRoot: cfg.modelsRoot,
    signals: guided,
  }).catch(() => null);
  const merged =
    emotion || voice
      ? {
          loudPeaks: [],
          cutDense: [],
          ...guided,
          ...(emotion ? { emotionPeaks: emotion.emotionPeaks } : {}),
          ...(voice
            ? { voiceEmotionPeaks: voice.voiceEmotionPeaks, audioEventPeaks: voice.audioEventPeaks }
            : {}),
        }
      : guided;
  const outcome = await detectHighlights(
    transcript, cfg.llm, cfg.signal, merged,
    undefined, undefined, undefined, cfg.reference, cfg.reviewMemory,
    undefined, undefined, cfg.performanceMemory
  );
  const max = Math.max(1, Math.min(12, Math.round(cfg.maxClips ?? 6)));
  return outcome.candidates.slice(0, max);
}

/** 全托管一条龙:转写 → 找爆点 → 导出推荐条(竖屏/字幕/跳剪/响度默认全开)。 */
export async function autoClip(videoPath: string, cfg: AutoClipConfig): Promise<AutoClipResult> {
  cfg.signal?.throwIfAborted();
  cfg.onStage?.("transcribing");
  const transcript = await transcribeCached(videoPath, cfg.modelsRoot, cfg.cacheDir, cfg.glossary, cfg.signal, cfg.subtitlePath, cfg.asr);
  cfg.signal?.throwIfAborted();
  cfg.onStage?.("detecting");
  const candidates = await detectForPipeline(videoPath, transcript, cfg);
  cfg.signal?.throwIfAborted();
  // 无人值守只发「建议发」档:质量门判需人审/弃的没有人看过,不能自动发出去
  // (gate 缺省 = 信号候选/复评没跑,沿用 recommended 的老语义)
  const publishable = candidates.filter((c) => c.recommended && (c.gate === undefined || c.gate === "publish"));
  const outDir =
    cfg.outDir ?? join(dirname(videoPath), `${sanitizeFilename(basename(videoPath, extname(videoPath)), "video")}-hotclip`);
  if (publishable.length === 0) return { outDir, transcript, candidates, exported: [] };
  cfg.onStage?.("exporting");
  const vertical = cfg.vertical !== false;
  const captions = cfg.captions !== false;
  const exported = await exportClips(
    videoPath,
    publishable.map((c) => ({
      id: c.id,
      title: c.title,
      startSec: c.startSec,
      endSec: c.endSec,
      // 多片段拼接:段清单带下去,词表只取真正剪进去的那几段
      pieces: c.pieces && c.pieces.length > 1 ? c.pieces : undefined,
      words: captions
        ? c.pieces && c.pieces.length > 1
          ? wordsInPieces(sliceWords(transcript, c.startSec, c.endSec), c.pieces)
          : sliceWords(transcript, c.startSec, c.endSec)
        : undefined,
      keywords: c.keywords,
      meta: {
        hook: c.hook,
        score: c.score,
        reason: c.reason,
        text: c.text,
        recommended: c.recommended,
        reviewNote: c.reviewNote,
        visualEvidence: c.visualEvidence,
      },
    })),
    outDir,
    {
      vertical,
      captionStyle: captions ? "keyword" : undefined,
      jumpCut: true,
      cleanFillers: true,
      titleCard: true,
      normalizeLoudness: true,
      autoEnhance: Boolean(cfg.autoEnhance),
      denoise: Boolean(cfg.denoiseMode),
      denoiseMode: cfg.denoiseMode,
      faceTrack: vertical,
      snapToShots: true,
      modelsRoot: cfg.modelsRoot,
      fontsDir: cfg.fontsDir,
      renderCacheDir: cfg.renderCacheDir,
      evidenceCacheDir: cfg.evidenceCacheDir,
    },
    undefined,
    cfg.signal
  );
  return { outDir, transcript, candidates, exported };
}
