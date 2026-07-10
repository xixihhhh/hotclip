/**
 * 自动切片公共管线(无 UI 依赖):转写(带缓存)→ 信号采集 → LLM 找爆点 →
 * 导出推荐切片。MCP Server 与录播监听(watch 文件夹)共用同一条路径,
 * 与桌面端"一键全自动"产出保持一致。
 */
import { join, dirname, basename, extname } from "path";
import { stat } from "fs/promises";
import type { LlmConfig, Transcript, HighlightCandidate } from "../shared/api-types";
import { SenseVoiceEngine } from "./transcribe/sensevoice";
import { readTranscriptCache, writeTranscriptCache } from "./transcribe/cache";
import { detectHighlights } from "./highlight/detect";
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
  maxClips?: number;
  vertical?: boolean;
  captions?: boolean;
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

/** 端侧转写(SenseVoice,带缓存;首次自动下载模型)。 */
export async function transcribeCached(videoPath: string, modelsRoot: string, cacheDir: string): Promise<Transcript> {
  const s = await stat(videoPath).catch(() => null);
  if (!s || !s.isFile()) throw new Error(`文件不存在或不可读: ${videoPath}`);
  const fileStat = { size: s.size, mtimeMs: s.mtimeMs };
  const cached = await readTranscriptCache(cacheDir, videoPath, fileStat, "sensevoice");
  if (cached) return cached;
  const engine = new SenseVoiceEngine(modelsRoot);
  const t = await engine.transcribe(videoPath);
  await writeTranscriptCache(cacheDir, videoPath, fileStat, "sensevoice", t).catch(() => {});
  return t;
}

/** 找爆点(与桌面端同款证据链:响度/镜头 + 表情峰值,全部 fail-open)。 */
export async function detectForPipeline(
  videoPath: string,
  transcript: Transcript,
  cfg: Pick<AutoClipConfig, "modelsRoot" | "llm" | "maxClips" | "signal">
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
  const outcome = await detectHighlights(transcript, cfg.llm, cfg.signal, merged);
  const max = Math.max(1, Math.min(12, Math.round(cfg.maxClips ?? 6)));
  return outcome.candidates.slice(0, max);
}

/** 全托管一条龙:转写 → 找爆点 → 导出推荐条(竖屏/字幕/跳剪/响度默认全开)。 */
export async function autoClip(videoPath: string, cfg: AutoClipConfig): Promise<AutoClipResult> {
  cfg.onStage?.("transcribing");
  const transcript = await transcribeCached(videoPath, cfg.modelsRoot, cfg.cacheDir);
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
