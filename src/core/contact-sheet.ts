/**
 * 候选帧接触表(contact sheet):把若干抽帧时刻拼成一张 3×N 九宫格 JPEG,
 * 每格左上角烧上大号序号——VLM 一次看九帧批量打分,调用次数比逐帧降一个
 * 量级;同一张图也能落盘给人快速扫片。
 *
 * 参数构建/分组是纯函数(可单测);composeContactSheetJpeg 才真正跑 ffmpeg:
 * 单次调用多路输入——每个时刻一路 -ss 快速定位,各取一帧 scale+drawtext
 * 序号,concat 串流后 tile 拼格,image2pipe 直出不落临时文件。
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { resolveFfmpegPath } from "./binaries";
import { escapeFilterPath } from "./cut";
import { analysisVideoFilter, type AnalysisVideoOptions } from "./analysis-video";
import { ffmpegVideoStreamSpecifier } from "./probe";

const execFileAsync = promisify(execFile);

/** 九宫格列数与满格容量。 */
export const SHEET_COLS = 3;
export const SHEET_CELLS = 9;

/** 单格宽度(px):448 与逐帧研判同规,九宫格总幅面 ~1344 宽,VLM 看得清。 */
const CELL_WIDTH = 448;

/** 把时刻数组按满格容量分组(最后一组可不满)。 */
export function chunkCells<T>(items: T[], size = SHEET_CELLS): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface SheetOptions extends AnalysisVideoOptions {
  /** 序号标注字体(缺省不烧序号——VLM 只能按位置数格,能烧尽量烧)。 */
  fontFile?: string;
  cellWidth?: number;
}

/**
 * 一次 ffmpeg 调用的完整参数(纯函数)。n 路输入各 -ss 定位取一帧,
 * scale 统一宽度、drawtext 烧序号,concat 成帧流后 tile 成网格。
 * 单帧退化为不拼格,只缩放标注。
 */
export function buildSheetArgs(
  videoPath: string,
  times: number[],
  opts: SheetOptions = {}
): string[] {
  if (times.length === 0) throw new Error("contact sheet requires at least one time");
  const n = times.length;
  const w = opts.cellWidth ?? CELL_WIDTH;
  const inputs = times.flatMap((t) => ["-ss", Math.max(0, t).toFixed(2), "-i", videoPath]);
  const label = (i: number): string =>
    opts.fontFile
      ? `,drawtext=fontfile='${escapeFilterPath(opts.fontFile)}':text='${i + 1}':x=10:y=6:fontsize=${Math.round(w * 0.16)}:fontcolor=white:borderw=5:bordercolor=black`
      : "";
  // 每路输入只取第一帧(trim 到 1 帧即 EOF,concat 才不会等整条流)
  const cells = times.map((_t, i) => {
    const source = ffmpegVideoStreamSpecifier(opts.videoStreamIndex, i);
    const filters = analysisVideoFilter(
      [`trim=end_frame=1`, "setpts=PTS-STARTPTS", `scale=${w}:-2${label(i)}`],
      opts.color
    );
    return `[${source}]${filters}[f${i}]`;
  });
  const labels = times.map((_t, i) => `[f${i}]`).join("");
  const cols = Math.min(SHEET_COLS, n);
  const rows = Math.ceil(n / cols);
  // 单帧不拼格;多帧 concat 串流 → tile 网格(不满格用黑底补齐)
  const graph =
    n === 1
      ? [cells[0].replace("[f0]", "[sheet]")]
      : [...cells, `${labels}concat=n=${n}:v=1:a=0,tile=${cols}x${rows}:color=black[sheet]`];
  return [
    "-hide_banner", "-loglevel", "error",
    ...inputs,
    "-filter_complex", graph.join(";"),
    "-map", "[sheet]",
    "-frames:v", "1",
    "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "5",
    "-",
  ];
}

/** 拼一张接触表,返回 base64 JPEG;任何失败返回 null(fail-open)。 */
export async function composeContactSheetJpeg(
  videoPath: string,
  times: number[],
  opts: SheetOptions = {}
): Promise<string | null> {
  if (times.length === 0) return null;
  try {
    const { stdout } = await execFileAsync(resolveFfmpegPath(), buildSheetArgs(videoPath, times, opts), {
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.length > 0 ? stdout.toString("base64") : null;
  } catch {
    return null;
  }
}
