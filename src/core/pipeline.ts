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
import { readTranscriptCache, writeTranscriptCache } from "./transcribe/cache";
import { detectHighlights } from "./highlight/detect";
import { detectShotBoundaries } from "./shots";
import { buildReferenceProfile, type ReferenceProfile } from "./reference";
import type { ReviewRecord } from "./review-memory";
import { collectSignals } from "./signals";
import { collectEmotionSignal } from "./emotion";
import { collectDanmakuSignal } from "./danmaku";
import { exportClips, sanitizeFilename, type ExportedClip } from "./export";
import { sliceWords } from "./subtitle";

export interface AutoClipConfig {
  modelsRoot: string;
  cacheDir: string;
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
  /** 参考爆款画像(analyzeReferenceVideo 的产物);选段向它的节奏靠拢。 */
  reference?: ReferenceProfile;
  /** 本机审阅记忆(桌面审阅台积累的采用/否决样例);选段向用户口味靠拢。 */
  reviewMemory?: ReviewRecord[];
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
  glossary?: GlossaryEntry[]
): Promise<Transcript> {
  const s = await stat(videoPath).catch(() => null);
  if (!s || !s.isFile()) throw new Error(`文件不存在或不可读: ${videoPath}`);
  const fileStat = { size: s.size, mtimeMs: s.mtimeMs };
  const applied = (t: Transcript): Transcript => applyGlossaryToTranscript(t, glossary ?? []).transcript;
  const cached = await readTranscriptCache(cacheDir, videoPath, fileStat, "sensevoice");
  if (cached) return applied(cached);
  const engine = new SenseVoiceEngine(modelsRoot);
  const t = await engine.transcribe(videoPath);
  await writeTranscriptCache(cacheDir, videoPath, fileStat, "sensevoice", t).catch(() => {});
  return applied(t);
}

/**
 * 分析参考爆款 → 风格画像:端侧转写(带缓存)+ 全片镜头检测。
 * 转写失败上抛(用户显式给的输入,静默丢弃是坑);镜头检测失败退 null 维度。
 */
export async function analyzeReferenceVideo(
  refPath: string,
  cfg: Pick<AutoClipConfig, "modelsRoot" | "cacheDir" | "glossary" | "signal">
): Promise<ReferenceProfile> {
  const transcript = await transcribeCached(refPath, cfg.modelsRoot, cfg.cacheDir, cfg.glossary);
  const durationSec =
    transcript.durationSec > 0
      ? transcript.durationSec
      : transcript.segments[transcript.segments.length - 1]?.endSec ?? 0;
  const boundaries = await detectShotBoundaries(refPath, 0, durationSec, cfg.modelsRoot).catch(
    () => null
  );
  return buildReferenceProfile(transcript, boundaries);
}

/** 找爆点(与桌面端同款证据链:响度/镜头 + 表情峰值,全部 fail-open)。 */
export async function detectForPipeline(
  videoPath: string,
  transcript: Transcript,
  cfg: Pick<AutoClipConfig, "modelsRoot" | "llm" | "maxClips" | "reference" | "reviewMemory" | "signal">
): Promise<HighlightCandidate[]> {
  if (transcript.segments.length === 0) throw new Error("转写结果为空(可能是无人声素材)");
  const signals = await collectSignals(videoPath).catch(() => undefined);
  const emotion = await collectEmotionSignal({
    videoPath,
    durationSec: transcript.durationSec,
    modelsRoot: cfg.modelsRoot,
    signals,
  }).catch(() => null);
  // 弹幕热度(零配置):录播姬随录播落的同名 .xml 自动发现——录播监听场景的主证据
  const danmaku = await collectDanmakuSignal(videoPath, transcript.durationSec);
  const merged =
    emotion || danmaku
      ? {
          loudPeaks: [],
          cutDense: [],
          ...signals,
          ...(emotion ? { emotionPeaks: emotion.emotionPeaks } : {}),
          ...(danmaku ? { danmakuPeaks: danmaku.danmakuPeaks } : {}),
        }
      : signals;
  const outcome = await detectHighlights(
    transcript, cfg.llm, cfg.signal, merged,
    undefined, undefined, undefined, cfg.reference, cfg.reviewMemory
  );
  const max = Math.max(1, Math.min(12, Math.round(cfg.maxClips ?? 6)));
  return outcome.candidates.slice(0, max);
}

/** 全托管一条龙:转写 → 找爆点 → 导出推荐条(竖屏/字幕/跳剪/响度默认全开)。 */
export async function autoClip(videoPath: string, cfg: AutoClipConfig): Promise<AutoClipResult> {
  cfg.onStage?.("transcribing");
  const transcript = await transcribeCached(videoPath, cfg.modelsRoot, cfg.cacheDir, cfg.glossary);
  cfg.onStage?.("detecting");
  const candidates = await detectForPipeline(videoPath, transcript, cfg);
  const publishable = candidates.filter((c) => c.recommended);
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
      words: captions ? sliceWords(transcript, c.startSec, c.endSec) : undefined,
      keywords: c.keywords,
      meta: { hook: c.hook, score: c.score, reason: c.reason, text: c.text, recommended: c.recommended, reviewNote: c.reviewNote },
    })),
    outDir,
    {
      vertical,
      captionStyle: captions ? "karaoke" : undefined,
      jumpCut: true,
      cleanFillers: true,
      titleCard: true,
      normalizeLoudness: true,
      faceTrack: vertical,
      snapToShots: true,
      modelsRoot: cfg.modelsRoot,
      fontsDir: cfg.fontsDir,
    },
    undefined,
    cfg.signal
  );
  return { outDir, transcript, candidates, exported };
}
