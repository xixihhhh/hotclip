/**
 * Audiogram 出片:纯音频源(播客/录音)导出时自动合成画面——深色底 +
 * 品牌色波形动画(ffmpeg showwaves)+ 既有字幕/标题贴片/水印照常烧录。
 * 静态封面会被划走,会动的波形加字幕才能在信息流里留住人;Headliner/Wavve
 * 靠这一个能力撑起整个产品,这里作为纯音频输入的默认画面方案内建。
 *
 * 单段剪切与跳剪多段统一走 filter_complex:先把音频段剪好拼好,再从
 * 成品音频生成波形(所以跳剪后的波形与声音天然同步)。纯参数构建可单测;
 * ffmpeg 执行隔离在 runAudiogram。
 */
import { escapeFilterPath, watermarkStages, metadataArgs, runFfmpeg, type WatermarkSpec } from "./cut";
import { isValidHex } from "./brand";

/** 深色底(与应用「灼热片场」底色同源)。 */
const BG_COLOR = "0x141110";
/** 默认波形色 = 火焰橙。 */
const DEFAULT_WAVE_COLOR = "0xFF6E0D";

export interface AudiogramSpec {
  width: number;
  height: number;
  /** ffmpeg 颜色形式 0xRRGGBB。 */
  waveColor: string;
  bgColor: string;
  /** 波形条带高度(居中叠放)。 */
  waveHeight: number;
}

/** "#FF6E0D" → "0xFF6E0D";非法输入回落默认橙。 */
export function hexToFfmpegColor(hex?: string): string {
  return isValidHex(hex) ? `0x${hex!.slice(1).toUpperCase()}` : DEFAULT_WAVE_COLOR;
}

/** 竖屏 1080×1920 / 横屏 1920×1080;波形约占高的 1/4,避开底部字幕区。 */
export function audiogramSpec(vertical: boolean, highlightHex?: string): AudiogramSpec {
  const width = vertical ? 1080 : 1920;
  const height = vertical ? 1920 : 1080;
  return {
    width,
    height,
    waveColor: hexToFfmpegColor(highlightHex),
    bgColor: BG_COLOR,
    waveHeight: vertical ? 480 : 280,
  };
}

export interface AudiogramOptions {
  spec: AudiogramSpec;
  subtitlePath?: string;
  fontsDir?: string;
  normalizeLoudness?: boolean;
  watermark?: WatermarkSpec;
  /** 容器元数据(如 AIGC 隐式标识)。 */
  metadata?: Record<string, string>;
  crf?: number;
  preset?: string;
}

/** 与 cut.ts 相同的响度目标(-14 LUFS 社媒标准)。 */
const LOUDNORM = "loudnorm=I=-14:TP=-1.5:LRA=11";

/**
 * 组装 audiogram 的 ffmpeg 参数。ranges 为源音频绝对秒(跳剪时多段);
 * fast seek 到首段起点,段内时刻用相对表达。纯函数。
 */
export function buildAudiogramArgs(
  inputPath: string,
  outputPath: string,
  ranges: Array<{ startSec: number; endSec: number }>,
  options: AudiogramOptions
): string[] {
  if (ranges.length === 0 || ranges.some((r) => !(r.endSec > r.startSec))) {
    throw new Error("audiogram requires at least one valid range");
  }
  const { spec } = options;
  const base = Math.max(0, ranges[0].startSec);
  const parts: string[] = [];

  // 1) 音频段剪切与拼接(相对 fast-seek 点)
  const segLabels: string[] = [];
  ranges.forEach((r, i) => {
    const from = Math.max(0, r.startSec - base);
    const to = Math.max(from, r.endSec - base);
    parts.push(`[0:a]atrim=start=${from.toFixed(3)}:end=${to.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
    segLabels.push(`[a${i}]`);
  });
  let audioLabel = "[a0]";
  if (ranges.length > 1) {
    parts.push(`${segLabels.join("")}concat=n=${ranges.length}:v=0:a=1[acat]`);
    audioLabel = "[acat]";
  }
  // 2) 可选响度标准化(在拼接后的完整音频上做,与视频路径一致)
  if (options.normalizeLoudness) {
    parts.push(`${audioLabel}${LOUDNORM},aresample=48000[anorm]`);
    audioLabel = "[anorm]";
  }
  // 3) 一份出声,一份画波形
  parts.push(`${audioLabel}asplit=2[aout][awave]`);
  parts.push(
    `[awave]showwaves=s=${spec.width}x${spec.waveHeight}:mode=cline:rate=30:colors=${spec.waveColor}[wv]`
  );
  // 4) 深色底 + 波形居中;shortest=1 让无限时长的底随波形结束
  parts.push(`color=c=${spec.bgColor}:size=${spec.width}x${spec.height}:rate=30[bg]`);
  parts.push(`[bg][wv]overlay=x=0:y=(H-h)/2:shortest=1[v0]`);
  // 5) 字幕/水印(与视频路径同一套素材)
  let videoLabel = "[v0]";
  if (options.subtitlePath) {
    const fonts = options.fontsDir ? `:fontsdir='${escapeFilterPath(options.fontsDir)}'` : "";
    parts.push(`${videoLabel}subtitles=filename='${escapeFilterPath(options.subtitlePath)}'${fonts}[v1]`);
    videoLabel = "[v1]";
  }
  if (options.watermark) {
    const s = watermarkStages(options.watermark);
    parts.push(`${s.source}[wm]`);
    parts.push(`${videoLabel}[wm]${s.overlay}[vout]`);
    videoLabel = "[vout]";
  }

  const crf = Number.isFinite(options.crf) ? String(options.crf) : "18";
  return [
    "-hide_banner", "-y",
    "-ss", base.toFixed(3), "-i", inputPath,
    "-filter_complex", parts.join(";"),
    "-map", videoLabel, "-map", "[aout]",
    "-c:v", "libx264",
    "-preset", options.preset ?? "veryfast",
    "-crf", crf,
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    ...metadataArgs(options.metadata),
    outputPath,
  ];
}

/** 执行 audiogram 出片(与 cutClip 同风格的 ffmpeg 包装)。 */
export async function runAudiogram(
  inputPath: string,
  outputPath: string,
  ranges: Array<{ startSec: number; endSec: number }>,
  options: AudiogramOptions,
  signal?: AbortSignal,
  onTimeSec?: (sec: number) => void
): Promise<void> {
  const args = buildAudiogramArgs(inputPath, outputPath, ranges, options);
  await runFfmpeg(args, { signal, onTimeSec });
}
