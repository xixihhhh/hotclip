/**
 * 环境自检(doctor):首跑失败的三大元凶——模型没下好、ffmpeg 不可用、
 * LLM 端点没配——一条命令全查清,能自动修的给出修法。检查逻辑与渲染
 * 分离(纯数据结果),CLI 先用,桌面端设置页以后可直接复用。
 */
import { readdir, stat } from "fs/promises";
import { statfs } from "fs/promises";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import type { LlmConfig } from "../shared/api-types";
import { resolveFfmpegPath, resolveFfprobePath } from "./binaries";
import {
  isModelInstalled,
  modelDir,
  type ModelAsset,
  SENSEVOICE_MODEL,
  PARAFORMER_MODEL,
  FIRERED_MODEL,
  YUNET_MODEL,
  EMOTION_MODEL,
  PUNCT_MODEL,
  TRANSNETV2_MODEL,
  SEGMENTATION_MODEL,
  SPEAKER_EMBEDDING_MODEL,
} from "./models";

const execFileAsync = promisify(execFile);

export interface DoctorCheck {
  /** 检查项名称(用户可读)。 */
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  /** 能照做的修复建议(没有则省略)。 */
  fix?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  /** 默认管线要用但还没装的模型——`--download` 的预下载对象。 */
  missingCoreModels: ModelAsset[];
}

/** 模型清单:core=默认管线必经(clip 一条龙会自动触发下载)。 */
const MODEL_ROWS: Array<{ asset: ModelAsset; label: string; core: boolean }> = [
  { asset: SENSEVOICE_MODEL, label: "转写 SenseVoice(默认档)", core: true },
  { asset: YUNET_MODEL, label: "人脸检测 YuNet(竖屏取景)", core: true },
  { asset: EMOTION_MODEL, label: "表情识别 FER+(爆点信号)", core: true },
  { asset: TRANSNETV2_MODEL, label: "镜头检测 TransNetV2(切点吸附)", core: true },
  { asset: PARAFORMER_MODEL, label: "转写 Paraformer(更准档)", core: false },
  { asset: FIRERED_MODEL, label: "转写 FireRedASR2(最准档)", core: false },
  { asset: PUNCT_MODEL, label: "标点恢复(更准档转写需要)", core: false },
  { asset: SEGMENTATION_MODEL, label: "说话人分离·分段", core: false },
  { asset: SPEAKER_EMBEDDING_MODEL, label: "说话人分离·声纹", core: false },
];

const MB = 1024 * 1024;
const fmtMB = (bytes: number): string => `${Math.max(1, Math.round(bytes / MB))}MB`;
const fmtGB = (bytes: number): string => `${(bytes / (1024 * MB)).toFixed(1)}GB`;

/** 目录递归总大小;不存在按 0 算。 */
export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) {
      try {
        total += (await stat(p)).size;
      } catch {
        // 竞态删除:忽略
      }
    }
  }
  return total;
}

/** ffmpeg/ffprobe 可用性:能解析到路径且 -version 跑得动。 */
async function checkBinary(name: string, resolve: () => string): Promise<DoctorCheck> {
  try {
    const bin = resolve();
    const { stdout } = await execFileAsync(bin, ["-version"], { maxBuffer: 1024 * 1024 });
    const firstLine = stdout.split("\n")[0]?.trim() ?? "";
    return { name, status: "ok", detail: firstLine || "可用" };
  } catch (e) {
    return {
      name,
      status: "fail",
      detail: e instanceof Error ? e.message : String(e),
      fix: "重装依赖以恢复内置二进制:pnpm install",
    };
  }
}

/** 单个模型状态:已装(实际体积)/有断点(续传量)/未装(自动下载量)。 */
async function checkModel(
  modelsRoot: string,
  row: { asset: ModelAsset; label: string; core: boolean }
): Promise<{ check: DoctorCheck; missing: boolean }> {
  const { asset, label, core } = row;
  if (await isModelInstalled(modelsRoot, asset)) {
    const size = await dirSize(modelDir(modelsRoot, asset));
    return { check: { name: label, status: "ok", detail: `已安装(${fmtMB(size)})` }, missing: false };
  }
  let partial = 0;
  try {
    partial = (await stat(join(modelsRoot, `${asset.id}.download.tar.bz2`))).size;
  } catch {
    // 无断点文件
  }
  const resume = partial > 0 ? `,已有断点 ${fmtMB(partial)} 会续传` : "";
  if (core) {
    return {
      check: {
        name: label,
        status: "warn",
        detail: `未安装(约 ${fmtMB(asset.approxBytes)}${resume})`,
        fix: "现在预下载:pnpm cli doctor --download(也可等首次使用时自动下载)",
      },
      missing: true,
    };
  }
  return {
    check: { name: label, status: "ok", detail: `未安装(可选,用到时自动下载,约 ${fmtMB(asset.approxBytes)}${resume})` },
    missing: false,
  };
}

/** LLM 配置与端点连通性:能收到任何 HTTP 响应就算可达(不校验路由)。 */
async function checkLlm(llm: LlmConfig | null): Promise<DoctorCheck> {
  if (!llm) {
    return {
      name: "LLM 配置",
      status: "warn",
      detail: "未配置(transcribe 不需要;highlights/clip 需要)",
      fix: "设置 HOTCLIP_LLM_BASE_URL 与 HOTCLIP_LLM_MODEL(本地 Ollama: http://localhost:11434/v1,免 key)",
    };
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      await fetch(`${llm.baseUrl.replace(/\/$/, "")}/models`, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    return { name: "LLM 端点", status: "ok", detail: `${llm.model} @ ${llm.baseUrl} 可达` };
  } catch {
    return {
      name: "LLM 端点",
      status: "warn",
      detail: `${llm.baseUrl} 连不上`,
      fix: "确认服务已启动(本地 Ollama:ollama serve)且地址端口正确",
    };
  }
}

/** 磁盘余量:模型全家桶 ~1.5GB + 出片工作区,低于 3GB 提醒。 */
async function checkDisk(modelsRoot: string): Promise<DoctorCheck | null> {
  try {
    const s = await statfs(modelsRoot);
    const free = s.bavail * s.bsize;
    if (free < 3 * 1024 * MB) {
      return {
        name: "磁盘空间",
        status: "warn",
        detail: `可用仅 ${fmtGB(free)}`,
        fix: "清理磁盘:模型全家桶约 1.5GB,出片还需工作空间",
      };
    }
    return { name: "磁盘空间", status: "ok", detail: `可用 ${fmtGB(free)}` };
  } catch {
    // statfs 不可用(老 Node/罕见文件系统):跳过而不是误报
    return null;
  }
}

/**
 * 跑全部自检。llm 传 null 表示未配置(CLI 侧从环境变量解析后传入,
 * 便于单测与桌面端各自接线)。
 */
export async function runDoctor(opts: {
  modelsRoot: string;
  cacheDir: string;
  llm: LlmConfig | null;
}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const missingCoreModels: ModelAsset[] = [];

  checks.push(await checkBinary("ffmpeg", resolveFfmpegPath));
  checks.push(await checkBinary("ffprobe", resolveFfprobePath));

  for (const row of MODEL_ROWS) {
    const { check, missing } = await checkModel(opts.modelsRoot, row);
    checks.push(check);
    if (missing) missingCoreModels.push(row.asset);
  }

  checks.push(await checkLlm(opts.llm));

  const disk = await checkDisk(opts.modelsRoot);
  if (disk) checks.push(disk);

  const cacheBytes = await dirSize(opts.cacheDir);
  checks.push({
    name: "转写缓存",
    status: "ok",
    detail: cacheBytes > 0 ? `${fmtMB(cacheBytes)}(同文件重开秒进)` : "空(转写后自动积累)",
  });

  return { checks, missingCoreModels };
}
