/**
 * Windows 非 ASCII 路径救援(issue #4)。
 *
 * sherpa-onnx 原生层用 ANSI(std::ifstream)打开模型文件,路径里有中文等
 * 非 ASCII 字符时(最常见:中文用户名的 C:\Users\楚心\...)按系统代码页
 * 误解 UTF-8 字节,一律打不开,recognizer 创建直接抛 "Please check your
 * config!"。Node 自己的 fs 走宽字符 API 没这个问题——所以模型下载、清点
 * 都正常,只有交给原生层的路径会炸。
 *
 * 解法:把已存在的目录转成 8.3 短路径(每段都是纯 ASCII,如 C:\Users\
 * 3F2D~1\...)再交给原生层。转不了(卷关闭了 8.3 生成等)就原样返回,
 * 由错误归因层对症提示用户把模型位置换到纯英文路径。
 */
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** 路径是否含 ANSI 打不开的字符(保守口径:非 ASCII 可打印区间即算)。 */
export function hasNonAscii(path: string): boolean {
  return /[^\x20-\x7e]/.test(path);
}

/** PowerShell 单引号字符串字面量:内部单引号翻倍,无其他转义规则。 */
export function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * 仅 win32 且路径含非 ASCII 时把已存在的目录转成 8.3 短路径;其余情形
 * (或转换失败/结果仍含非 ASCII)原样返回,绝不抛错——这里只是救援,
 * 失败后的报错归因另有出口。
 */
export async function toAnsiSafeDir(dir: string): Promise<string> {
  if (process.platform !== "win32" || !hasNonAscii(dir)) return dir;
  try {
    const script = `(New-Object -ComObject Scripting.FileSystemObject).GetFolder(${psQuote(dir)}).ShortPath`;
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 15_000 }
    );
    const short = stdout.trim();
    // 卷未开 8.3 时 ShortPath 返回长名原样(仍含非 ASCII)——视为没转成
    if (short && !hasNonAscii(short)) return short;
  } catch {
    /* PowerShell 不可用/超时:退回原路径 */
  }
  return dir;
}
