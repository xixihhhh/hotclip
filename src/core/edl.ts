/**
 * 时间线 EDL 导出(CMX3600):把 AI 选出的切点——含跳剪在片内的每一段
 * 保留区间——写成剪辑软件通用的 EDL 时间线,DaVinci Resolve / Premiere /
 * Final Cut 里重链源片就能继续精修。"AI 粗剪 → 人精修"的工作流桥梁:
 * 切点是机器找的,最后一刀永远可以是人的。
 *
 * CMX3600 是纯文本、最通用的时间线交换格式;每个保留区间一个 event,
 * record 侧按顺序连续拼接。纯字符串构建,零依赖,可逐字节断言。
 */

export interface EdlClip {
  /** 切片标题(注释行,Resolve 会显示为 clip name)。 */
  title: string;
  /** 该切片的保留区间(源片绝对秒;跳剪时一条切片有多段)。 */
  segments: Array<{ startSec: number; endSec: number }>;
}

/** 秒 → SMPTE 非丢帧时间码 HH:MM:SS:FF。 */
export function secToTimecode(sec: number, fps: number): string {
  const fpsInt = Math.max(1, Math.round(fps));
  const totalFrames = Math.round(Math.max(0, sec) * fpsInt);
  const ff = totalFrames % fpsInt;
  const totalSec = Math.floor(totalFrames / fpsInt);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(h)}:${p(m)}:${p(s)}:${p(ff)}`;
}

/**
 * 组装 CMX3600 EDL。事件按传入顺序排,record 侧从 0 连续累计——
 * 导入后就是"成片顺序"的时间线,每段都反链回源片对应位置。
 */
export function buildEdl(opts: { title: string; sourceName: string; fps: number; clips: EdlClip[] }): string {
  const { title, sourceName, fps, clips } = opts;
  const lines: string[] = [`TITLE: ${title}`, "FCM: NON-DROP FRAME", ""];
  let event = 0;
  let recordSec = 0;
  for (const clip of clips) {
    for (const seg of clip.segments) {
      const dur = seg.endSec - seg.startSec;
      if (dur <= 0) continue;
      event += 1;
      const num = String(event).padStart(3, "0");
      const srcIn = secToTimecode(seg.startSec, fps);
      const srcOut = secToTimecode(seg.endSec, fps);
      const recIn = secToTimecode(recordSec, fps);
      const recOut = secToTimecode(recordSec + dur, fps);
      // AX = 辅助卷号(现代软件按 FROM CLIP NAME 重链);B = 视频+音频一起切
      lines.push(`${num}  AX       B     C        ${srcIn} ${srcOut} ${recIn} ${recOut}`);
      lines.push(`* FROM CLIP NAME: ${sourceName}`);
      lines.push(`* COMMENT: ${clip.title}`);
      lines.push("");
      recordSec += dur;
    }
  }
  return lines.join("\n");
}
