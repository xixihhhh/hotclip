/**
 * HTTP Range 头解析——本地媒体预览协议(hotclip-media://)的分段响应核心。
 * <video> 拖进度条完全依赖 206 分段;解析错一个边界就是黑屏或无限缓冲,
 * 所以抽成纯函数单测覆盖。
 */

export interface ByteRange {
  start: number;
  end: number;
  /** 200 = 整文件;206 = 分段。 */
  status: 200 | 206;
}

/**
 * 解析 Range 头(bytes=a-b / bytes=a- / bytes=-n 三种形态)。
 * 返回 null 表示范围不可满足(应回 416);无 Range 头或形态不识别时回整文件。
 */
export function resolveByteRange(rangeHeader: string | null, size: number): ByteRange | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader ?? "");
  if (!m || (!m[1] && !m[2])) return { start: 0, end: size - 1, status: 200 };
  let start = 0;
  let end = size - 1;
  if (m[1]) {
    start = Number(m[1]);
    if (m[2]) end = Math.min(Number(m[2]), size - 1);
  } else {
    // bytes=-n:取末尾 n 字节
    start = Math.max(0, size - Number(m[2]));
  }
  if (start >= size || start > end) return null;
  return { start, end, status: 206 };
}
