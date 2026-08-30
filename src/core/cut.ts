/**
 * Clip cutting: extract [start, end] from a source video via ffmpeg.
 * `buildCutArgs` is a pure function (unit-testable); only `cutClip` executes.
 *
 * Two modes:
 *  - "accurate" (default): re-encode with fast seek + output seek trim.
 *    Frame-accurate boundaries — required for hook-first clips where the
 *    first second matters. veryfast x264 keeps a 60s clip under ~10s encode.
 *  - "copy": stream copy. Near-instant but cuts snap to keyframes (can be
 *    seconds off on livestream VODs with sparse keyframes) — preview only.
 */
import { spawn } from "child_process";
import { writeFile, rm } from "fs/promises";
import { resolveFfmpegPath } from "./binaries";
import { toFfmpegTime } from "./time";
import { buildZoomFilter } from "./autozoom";
import { colorOutputArgs, hdrToneMapFilter, type ColorRenderPlan } from "./color";
import { ffmpegAudioStreamSpecifier, ffmpegVideoStreamSpecifier } from "./probe";
import { videoEncoderArgs, type VideoEncoder } from "./video-encoder";
import { visualEnhanceFilter, type VisualEnhancePlan } from "./visual-enhance";

/**
 * Social loudness target (EBU R128): -14 LUFS integrated, -1.5 dBTP true-peak
 * ceiling — the level TikTok / Reels / Shorts / 抖音 normalize playback to, so
 * a batch of clips lands at one consistent, platform-friendly volume instead of
 * the source's raw (often too quiet) level.
 *
 * loudnorm runs its analysis at 192kHz internally and would hand that rate to
 * the AAC encoder (which caps at 96kHz). We pin the output rate with the `-ar`
 * output option (see LOUDNORM_OUT_RATE) rather than an in-graph aresample —
 * output-side resampling negotiates the channel layout, an in-graph one does not.
 */
export const LOUDNORM_FILTER = "loudnorm=I=-14:TP=-1.5:LRA=11";
/** Output sample rate forced alongside loudnorm to cap its 192kHz output. */
export const LOUDNORM_OUT_RATE = "48000";
/**
 * 基础降噪链:双 80Hz 高通(24dB/oct,压 50Hz 电流声及其嗡嗡感)+ afftdn
 * 谱减降噪(nr=24 取温和档防真人声伪影,tn=1 随时段跟踪噪底)。合成实测:
 * 静音段底噪 -7.7dB、语音段仅 -0.2dB。定位是零成本基础降噪,不是 AI 修音。
 * 永远排在 loudnorm 之前——先去噪再标准化,否则响度归一会把噪底一起抬起来。
 */
export const DENOISE_FILTER = "highpass=f=80,highpass=f=80,afftdn=nr=24:nf=-40:tn=1";

export function muteRangeFilters(ranges?: Array<{ startSec: number; endSec: number }>): string[] {
  return (ranges ?? [])
    .filter((range) => Number.isFinite(range.startSec) && range.endSec > range.startSec)
    .map((range) => `volume=enable='between(t,${Math.max(0, range.startSec).toFixed(3)},${range.endSec.toFixed(3)})':volume=0`);
}

/**
 * 切点边缘音频淡化时长:重编码切割的边界几乎必然落在波形非零点上,
 * 产生可闻的「咔哒」爆音;30ms 短到听不出淡化,却足以把边界钳到零附近。
 * 跳剪/高潮前置/合集的每段两端各自淡出+淡入,硬切拼缝天然平滑。
 */
export const EDGE_FADE_SEC = 0.03;

/**
 * 段边缘淡入淡出 filter(纯函数)。段太短(≤4×淡化时长)不淡——
 * 淡化会吃掉整段能量,反而比爆音更可闻。
 */
export function edgeFadeFilters(durationSec: number): string[] {
  if (!(durationSec > EDGE_FADE_SEC * 4)) return [];
  return [
    `afade=t=in:st=0:d=${EDGE_FADE_SEC}`,
    `afade=t=out:st=${(durationSec - EDGE_FADE_SEC).toFixed(3)}:d=${EDGE_FADE_SEC}`,
  ];
}

export type CutMode = "accurate" | "copy";

export interface CutOptions {
  mode?: CutMode;
  /**
   * Internal smart-render path: copy only the H.264 video stream while audio
   * still receives the normal fades/filters and AAC encoding. Callers must
   * prove keyframe alignment first; any pixel-changing filter disables it.
   */
  videoCopy?: boolean;
  /** ffprobe global stream index selected for the source picture. */
  videoStreamIndex?: number;
  /** ffprobe global stream index selected for source audio. */
  audioStreamIndex?: number;
  /** x264 CRF for accurate mode (lower = better); default 18 (visually lossless-ish). */
  crf?: number;
  /** x264 preset for accurate mode; default "veryfast". */
  preset?: string;
  /** Per-run encoder probe result. Hardware failures transparently retry with libx264. */
  encoder?: VideoEncoder;
  /** Crop away static screen-recording chrome first (fractions of height). */
  uiCrop?: { topFrac: number; bottomFrac: number };
  /**
   * Face-tracking reframe: crop x follows a piecewise-linear expression in t.
   * Replaces uiCrop+vertical (their geometry is folded into the plan).
   */
  trackPlan?: { cropXExpr: string; cropW: number; cropH: number; cropY: number };
  /** Reframe to 9:16 vertical (center crop → 1080×1920). Requires re-encode. */
  vertical?: boolean;
  /**
   * 自动运镜:竖屏成片叠一层缓慢推拉(见 autozoom.ts)。需要源帧率——
   * zoompan 不传 fps 会把素材重采样到 25fps。字段齐全才生效。
   */
  autoZoom?: { durationSec: number; fps: number; emphasisAtSec?: number[] };
  /** Conservative source-measured picture correction; neutral/skipped plans add no filter. */
  visualEnhance?: VisualEnhancePlan | null;
  /** HDR sources are tone-mapped to a tagged SDR output before any geometric or finishing filters. */
  color?: ColorRenderPlan;
  /** Burn an .ass karaoke subtitle file via libass. Requires re-encode. */
  subtitlePath?: string;
  /** Directory holding bundled fonts for libass (subtitles filter fontsdir). */
  fontsDir?: string;
  /** Normalize output audio to the -14 LUFS social target (EBU R128 loudnorm). */
  normalizeLoudness?: boolean;
  /** 基础降噪:压直播回放常见的底噪/电流声(高通×2 + afftdn,先于 loudnorm)。 */
  denoise?: boolean;
  /** Clip-output-relative ranges whose spoken audio should be muted. */
  muteRanges?: Array<{ startSec: number; endSec: number }>;
  /** 品牌水印:PNG 烧进画面一角(在字幕之上)。 */
  watermark?: WatermarkSpec;
  /** 容器元数据(如 AIGC 隐式标识);copy 模式同样写入。 */
  metadata?: Record<string, string>;
}

/** -metadata k=v 参数对(纯函数,cut 与 audiogram 共用)。 */
export function metadataArgs(metadata?: Record<string, string>): string[] {
  return Object.entries(metadata ?? {}).flatMap(([k, v]) => ["-metadata", `${k}=${v}`]);
}

/** 解析 ffmpeg -progress 输出块里的 out_time_us/out_time_ms → 已编码秒数。 */
export function parseFfmpegProgress(chunk: string): number | null {
  // out_time_us 是微秒;老字段 out_time_ms 名字带 ms 实际也是微秒(ffmpeg 历史坑)
  const m = chunk.match(/out_time_us=(\d+)/) ?? chunk.match(/out_time_ms=(\d+)/);
  if (!m) return null;
  const us = Number(m[1]);
  return Number.isFinite(us) ? us / 1_000_000 : null;
}

/**
 * spawn 版 ffmpeg 执行:-progress pipe:1 流式回报已编码秒数(切片内实时
 * 进度),stderr 只留尾部(报错定位),AbortSignal 直接 kill 子进程。
 * cut/jump-cut/audiogram 三条出片路径共用。
 */
export async function runFfmpeg(
  args: string[],
  opts: { signal?: AbortSignal; onTimeSec?: (sec: number) => void } = {}
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(resolveFfmpegPath(), ["-progress", "pipe:1", "-nostats", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      signal: opts.signal,
    });
    let stderrTail = "";
    child.stderr.on("data", (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-4000);
    });
    child.stdout.on("data", (d: Buffer) => {
      const sec = parseFfmpegProgress(d.toString());
      if (sec !== null) opts.onTimeSec?.(sec);
    });
    child.on("error", (e) => reject(e)); // 含 AbortError
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderrTail.split("\n").slice(-6).join("\n") || `ffmpeg exited ${code}`));
    });
  });
}

/** 水印参数(widthPx 由调用方按输出宽度算好传入)。 */
export interface WatermarkSpec {
  path: string;
  corner: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  /** 0..1。 */
  opacity: number;
  /** 缩放到的目标宽度(像素)。 */
  widthPx: number;
}

/** 水印距画面边缘的像素间距。 */
const WM_MARGIN = 44;

/**
 * 水印的两段 filter:source(movie 源读 PNG + 透明度 + 缩放)与 overlay
 * (按角落定位)。拆开返回,方便 -vf 与 filter_complex 两条路径各自组装。
 */
export function watermarkStages(wm: WatermarkSpec): { source: string; overlay: string } {
  const alpha = wm.opacity < 1 ? `,colorchannelmixer=aa=${wm.opacity.toFixed(3)}` : "";
  const pos = {
    "top-left": `${WM_MARGIN}:${WM_MARGIN}`,
    "top-right": `W-w-${WM_MARGIN}:${WM_MARGIN}`,
    "bottom-left": `${WM_MARGIN}:H-h-${WM_MARGIN}`,
    "bottom-right": `W-w-${WM_MARGIN}:H-h-${WM_MARGIN}`,
  }[wm.corner];
  return {
    source: `movie='${escapeFilterPath(wm.path)}',format=rgba${alpha},scale=${wm.widthPx}:-1`,
    overlay: `overlay=${pos}:format=auto`,
  };
}

/**
 * 把线性 -vf 链与水印合成为最终 -vf 表达式。无水印时保持原样;有水印时
 * 用 movie 源在 -vf 内部起第二路输入(字幕之后叠加,logo 永远在最上层)。
 */
export function composeVideoFilter(filters: string[], wm?: WatermarkSpec): string {
  if (!wm) return filters.join(",");
  const main = filters.length > 0 ? filters.join(",") : "copy";
  const s = watermarkStages(wm);
  return `${main}[main];${s.source}[wm];[main][wm]${s.overlay}`;
}

/**
 * ffmpeg filter-graph path escaping for the subtitles filter: forward slashes
 * everywhere, escape the Windows drive colon, guard stray quotes.
 */
export function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

/** Compose the -vf chain for reframing + caption burn-in. Empty = no filter. */
export function buildVideoFilters(options: CutOptions): string[] {
  const filters: string[] = [];
  const toneMap = options.color ? hdrToneMapFilter(options.color) : null;
  // HDR transfer/primaries must be normalized while pixels still represent the
  // untouched source. Geometry, zoom, picture finishing and text all operate on
  // the resulting SDR signal, preventing overlays from being tone-mapped too.
  if (toneMap) filters.push(toneMap);
  const enhance = visualEnhanceFilter(options.visualEnhance);
  // 自动运镜:zoompan 顶替 scale 那一步(它自己出目标尺寸);返回 null 就照旧
  const zoom = options.autoZoom
    ? buildZoomFilter(options.autoZoom.durationSec, options.autoZoom.fps, 1080, 1920, {
        emphasisAtSec: options.autoZoom.emphasisAtSec,
      })
    : null;
  const toVertical = zoom ? [zoom, "setsar=1"] : ["scale=1080:1920:flags=lanczos", "setsar=1"];
  if (options.trackPlan) {
    const p = options.trackPlan;
    filters.push(`crop=w=${p.cropW}:h=${p.cropH}:x='${p.cropXExpr}':y=${p.cropY}`);
    filters.push(...toVertical);
    if (enhance) filters.push(enhance);
    if (options.subtitlePath) {
      const fonts = options.fontsDir ? `:fontsdir='${escapeFilterPath(options.fontsDir)}'` : "";
      filters.push(`subtitles=filename='${escapeFilterPath(options.subtitlePath)}'${fonts}`);
    }
    return filters;
  }
  const ui = options.uiCrop;
  if (ui && (ui.topFrac > 0 || ui.bottomFrac > 0)) {
    // strip static screen-recording chrome BEFORE any reframe; keep dims even
    const keep = Math.max(0.2, 1 - ui.topFrac - ui.bottomFrac);
    filters.push(`crop=w=iw:h='floor(ih*${keep.toFixed(4)}/2)*2':x=0:y='floor(ih*${ui.topFrac.toFixed(4)}/2)*2'`);
  }
  if (options.vertical) {
    // Center crop to exactly 9:16 (whichever axis binds), then normalize size.
    filters.push("crop=w='min(iw,ih*9/16)':h='min(ih,iw*16/9)'", ...toVertical);
  }
  if (enhance) filters.push(enhance);
  if (options.subtitlePath) {
    const fonts = options.fontsDir ? `:fontsdir='${escapeFilterPath(options.fontsDir)}'` : "";
    filters.push(`subtitles=filename='${escapeFilterPath(options.subtitlePath)}'${fonts}`);
  }
  return filters;
}

/** Build the ffmpeg argument list for one cut. Pure — no I/O. */
export function buildCutArgs(
  inputPath: string,
  outputPath: string,
  startSec: number,
  endSec: number,
  options: CutOptions = {}
): string[] {
  if (!(endSec > startSec)) {
    throw new Error(`invalid cut range: start=${startSec} end=${endSec}`);
  }
  const filters = buildVideoFilters(options);
  // Any video filter — or an audio filter (loudnorm/denoise) — forces a
  // re-encode, so silently upgrade copy → accurate.
  const mode =
    filters.length > 0 || options.watermark || options.normalizeLoudness || options.denoise
      ? "accurate"
      : (options.mode ?? "accurate");
  const start = Math.max(0, startSec);
  const duration = endSec - start;

  // Fast seek: -ss BEFORE -i jumps by keyframe index (instant even at hour 3
  // of a VOD); the decoder then trims precisely inside the segment. Input
  // seeking also resets PTS to ~0, which is exactly what the clip-relative
  // ASS karaoke timestamps assume.
  const common = ["-hide_banner", "-y", "-ss", toFfmpegTime(start), "-i", inputPath, "-t", toFfmpegTime(duration)];
  const maps = [
    "-map", ffmpegVideoStreamSpecifier(options.videoStreamIndex),
    "-map", ffmpegAudioStreamSpecifier(options.audioStreamIndex, 0, true),
  ];

  if (mode === "copy") {
    return [...common, ...maps, "-c", "copy", "-avoid_negative_ts", "make_zero", ...metadataArgs(options.metadata), outputPath];
  }

  const crf = Number.isFinite(options.crf) ? String(options.crf) : "18";
  const preset = options.preset ?? "veryfast";
  const copyVideo = Boolean(options.videoCopy && filters.length === 0 && !options.watermark);
  // 音频链固定顺序:降噪 → 响度标准化(loudnorm 必须看到去噪后的音频)
  // → 边缘淡化(放最后,loudnorm 的动态增益才不会把淡化抬回去)
  const audioChain = [
    ...(options.denoise ? [DENOISE_FILTER] : []),
    ...(options.normalizeLoudness ? [LOUDNORM_FILTER] : []),
    ...muteRangeFilters(options.muteRanges),
    ...edgeFadeFilters(duration),
  ];
  return [
    ...common,
    ...maps,
    ...(filters.length > 0 || options.watermark ? ["-vf", composeVideoFilter(filters, options.watermark)] : []),
    ...(copyVideo
      ? ["-c:v", "copy"]
      : [...videoEncoderArgs(options.encoder ?? "libx264", Number(crf), preset), "-pix_fmt", "yuv420p"]),
    ...(options.color ? colorOutputArgs(options.color) : []),
    ...(audioChain.length > 0 ? ["-af", audioChain.join(",")] : []),
    ...(options.normalizeLoudness ? ["-ar", LOUDNORM_OUT_RATE] : []),
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    ...metadataArgs(options.metadata),
    outputPath,
  ];
}

/**
 * Jump-cut arg builder: keep only `segments` (absolute source time) of one
 * clip and splice them in a single filter_complex pass — trim/atrim → concat
 * → optional reframe + caption burn-in. Fast seek still applies: we seek to
 * the clip start and express segment times relative to the seek point.
 */
export function buildJumpCutArgs(
  inputPath: string,
  outputPath: string,
  clipStartSec: number,
  segments: Array<{ startSec: number; endSec: number }>,
  options: CutOptions = {}
): string[] {
  if (segments.length === 0) throw new Error("jump cut requires at least one segment");
  const seek = Math.max(0, clipStartSec);
  const lastEnd = segments[segments.length - 1].endSec;
  const readDuration = lastEnd - seek + 0.5; // small margin past the tail

  const parts: string[] = [];
  const labels: string[] = [];
  const videoInput = ffmpegVideoStreamSpecifier(options.videoStreamIndex);
  const audioInput = ffmpegAudioStreamSpecifier(options.audioStreamIndex);
  segments.forEach((s, i) => {
    const a = Math.max(0, s.startSec - seek);
    const b = Math.max(a, s.endSec - seek);
    parts.push(`[${videoInput}]trim=start=${a.toFixed(3)}:end=${b.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
    // 每段两端 30ms 淡化:相邻段的淡出+淡入在拼缝处相接,消掉跳剪爆音
    const fades = edgeFadeFilters(b - a);
    const fadeSuffix = fades.length > 0 ? `,${fades.join(",")}` : "";
    parts.push(`[${audioInput}]atrim=start=${a.toFixed(3)}:end=${b.toFixed(3)},asetpts=PTS-STARTPTS${fadeSuffix}[a${i}]`);
    labels.push(`[v${i}][a${i}]`);
  });
  const post = buildVideoFilters(options);
  const wm = options.watermark;
  const concatOut = post.length > 0 || wm ? "[vc]" : "[vout]";
  // Process the *spliced* audio (denoise/loudnorm must see the final
  // concatenated stream, not each segment) — concat → [araw] → chain → [aout].
  const audioChain = [
    ...(options.denoise ? [DENOISE_FILTER] : []),
    ...(options.normalizeLoudness ? [LOUDNORM_FILTER] : []),
    ...muteRangeFilters(options.muteRanges),
  ];
  const audioOut = audioChain.length > 0 ? "[araw]" : "[aout]";
  parts.push(`${labels.join("")}concat=n=${segments.length}:v=1:a=1${concatOut}${audioOut}`);
  if (wm) {
    // 水印永远最后叠(在字幕之上):后处理链 → [vmain],movie 源 → [wm],overlay 收口
    const s = watermarkStages(wm);
    const mainLabel = post.length > 0 ? "[vmain]" : "[vc]";
    if (post.length > 0) parts.push(`[vc]${post.join(",")}[vmain]`);
    parts.push(`${s.source}[wm]`);
    parts.push(`${mainLabel}[wm]${s.overlay}[vout]`);
  } else if (post.length > 0) {
    parts.push(`[vc]${post.join(",")}[vout]`);
  }
  if (audioChain.length > 0) parts.push(`[araw]${audioChain.join(",")}[aout]`);

  const crf = Number.isFinite(options.crf) ? String(options.crf) : "18";
  const preset = options.preset ?? "veryfast";
  return [
    "-hide_banner", "-y",
    "-ss", toFfmpegTime(seek),
    "-i", inputPath,
    "-t", toFfmpegTime(readDuration),
    "-filter_complex", parts.join(";"),
    "-map", "[vout]",
    "-map", "[aout]",
    ...videoEncoderArgs(options.encoder ?? "libx264", Number(crf), preset),
    "-pix_fmt", "yuv420p",
    ...(options.color ? colorOutputArgs(options.color) : []),
    ...(options.normalizeLoudness ? ["-ar", LOUDNORM_OUT_RATE] : []),
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    ...metadataArgs(options.metadata),
    outputPath,
  ];
}

/** Execute a jump cut. Throws with ffmpeg's stderr tail on failure. */
export async function cutJumpClip(
  inputPath: string,
  outputPath: string,
  clipStartSec: number,
  segments: Array<{ startSec: number; endSec: number }>,
  options: CutOptions = {},
  signal?: AbortSignal,
  onTimeSec?: (sec: number) => void
): Promise<void> {
  const args = buildJumpCutArgs(inputPath, outputPath, clipStartSec, segments, options);
  try {
    await runFfmpeg(args, { signal, onTimeSec });
  } catch (e) {
    if (options.encoder && options.encoder !== "libx264" && !signal?.aborted) {
      await runFfmpeg(
        buildJumpCutArgs(inputPath, outputPath, clipStartSec, segments, { ...options, encoder: "libx264" }),
        { signal, onTimeSec }
      );
      return;
    }
    const msg = e instanceof Error ? e.message : String(e);
    const tail = msg.split("\n").slice(-6).join("\n");
    throw new Error(`ffmpeg jump cut failed (${segments.length} segments): ${tail}`);
  }
}

/** Execute one cut. Throws with ffmpeg's stderr tail on failure. */
export async function cutClip(
  inputPath: string,
  outputPath: string,
  startSec: number,
  endSec: number,
  options: CutOptions = {},
  signal?: AbortSignal,
  onTimeSec?: (sec: number) => void
): Promise<"copy" | "encode"> {
  const args = buildCutArgs(inputPath, outputPath, startSec, endSec, options);
  try {
    await runFfmpeg(args, { signal, onTimeSec });
    return options.videoCopy ? "copy" : "encode";
  } catch (e) {
    // Smart video copy is an optimization only. Container/bitstream quirks can
    // still reject an otherwise eligible stream, so retry the proven accurate
    // path before considering hardware-encoder fallback.
    if (options.videoCopy && !signal?.aborted) {
      try {
        await runFfmpeg(
          buildCutArgs(inputPath, outputPath, startSec, endSec, { ...options, videoCopy: false }),
          { signal, onTimeSec }
        );
        return "encode";
      } catch (accurateError) {
        e = accurateError;
      }
    }
    if (options.encoder && options.encoder !== "libx264" && !signal?.aborted) {
      await runFfmpeg(
        buildCutArgs(inputPath, outputPath, startSec, endSec, { ...options, videoCopy: false, encoder: "libx264" }),
        { signal, onTimeSec }
      );
      return "encode";
    }
    const msg = e instanceof Error ? e.message : String(e);
    // ffmpeg errors bury the cause at the end of stderr — surface only the tail
    const tail = msg.split("\n").slice(-6).join("\n");
    throw new Error(`ffmpeg cut failed (${toFfmpegTime(startSec)}→${toFfmpegTime(endSec)}): ${tail}`);
  }
}

/** concat demuxer 列表文件内容(路径里的单引号按其语法转义)。 */
export function buildConcatList(paths: string[]): string {
  return paths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n";
}

/**
 * 拼接参数:同一管线导出的分片编码参数一致,流复制(-c copy)秒级完成、
 * 零画质损失;硬切衔接(合集/高潮前置的通行做法,转场要整体重编码)。
 * metadata 用于把容器元数据(如 AIGC 隐式标识)补到拼接产物上。
 */
export function buildConcatArgs(listPath: string, outputPath: string, metadata?: Record<string, string>): string[] {
  return ["-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", ...metadataArgs(metadata), outputPath];
}

/** 把多条已导出分片按序流复制拼接。列表文件落在输出旁,跑完即删。 */
export async function concatClips(
  paths: string[],
  outputPath: string,
  signal?: AbortSignal,
  metadata?: Record<string, string>
): Promise<void> {
  if (paths.length < 2) throw new Error("concat requires at least two clips");
  const listPath = `${outputPath}.list.txt`;
  await writeFile(listPath, buildConcatList(paths), "utf8");
  try {
    await runFfmpeg(buildConcatArgs(listPath, outputPath, metadata), { signal });
  } finally {
    await rm(listPath, { force: true });
  }
}
