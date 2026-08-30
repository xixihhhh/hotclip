/**
 * 时间轴缩略图胶片带:全片均匀抽 N 帧小图(JPEG base64),工作台时间轴
 * 铺在波形背后当"这一段是什么画面"的地图。单帧 200px 宽 q=6,八帧总量
 * 约 100KB,IPC 一次带走。fail-open:单帧失败落空串,渲染层跳过该格。
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { resolveFfmpegPath } from "./binaries";
import { analysisVideoFilter, type AnalysisVideoOptions } from "./analysis-video";
import { ffmpegVideoStreamSpecifier } from "./probe";

const execFileAsync = promisify(execFile);

/** 抽帧时刻:首尾各让 1%(边界帧常是黑场/转场半帧),中间均匀铺。纯函数。 */
export function filmstripTimes(durationSec: number, count: number): number[] {
  if (!(durationSec > 0) || count < 1) return [];
  const pad = durationSec * 0.01;
  const usable = durationSec - pad * 2;
  return Array.from({ length: count }, (_, i) => pad + (usable * (i + 0.5)) / count);
}

/** 抽一帧缩略图 → JPEG base64;失败返回空串。 */
async function grabFrame(
  ffmpeg: string,
  filePath: string,
  atSec: number,
  analysis: AnalysisVideoOptions
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      ffmpeg,
      [
        "-hide_banner", "-ss", atSec.toFixed(2), "-i", filePath,
        "-frames:v", "1",
        "-vf", analysisVideoFilter("scale=200:-2", analysis.color),
        "-map", ffmpegVideoStreamSpecifier(analysis.videoStreamIndex),
        "-q:v", "6", "-f", "mjpeg", "pipe:1",
      ],
      { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 }
    );
    return stdout.length > 0 ? stdout.toString("base64") : "";
  } catch {
    return "";
  }
}

/** 全片胶片带:均匀 count 帧,顺序返回(与 filmstripTimes 一一对应)。 */
export async function extractFilmstrip(
  filePath: string,
  durationSec: number,
  count = 8,
  analysis: AnalysisVideoOptions = {}
): Promise<string[]> {
  const ffmpeg = resolveFfmpegPath();
  const out: string[] = [];
  // 串行抽帧:seek 型单帧任务本身毫秒级,并发反而容易在机械盘上互相踩
  for (const t of filmstripTimes(durationSec, count)) {
    out.push(await grabFrame(ffmpeg, filePath, t, analysis));
  }
  return out;
}
