/**
 * Local AI model management: registry + first-run download with mirror
 * fallback (GitHub is slow/unreachable for many Chinese users, so every
 * asset lists proxy mirrors tried in order).
 *
 * Models live OUTSIDE the app bundle (user data dir) so app updates never
 * re-download them and the installer stays small.
 */
import { mkdir, open, readFile, rename, rm, stat } from "fs/promises";
import { createReadStream } from "fs";
import { pipeline } from "stream/promises";
import { join, dirname } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { x as tarExtract } from "tar";
import unbzip2 from "unbzip2-stream";

const execFileAsync = promisify(execFile);

export interface ModelAsset {
  id: string;
  /** Primary download URL (GitHub release asset). */
  url: string;
  /** Mirror prefixes tried before the primary URL for mainland-CN reachability. */
  mirrors: string[];
  /** Directory name the archive extracts to (tar.bz2 top-level folder). */
  extractedDir: string;
  /** Approximate size for progress UI. */
  approxBytes: number;
  /**
   * Single raw file instead of a tar.bz2 archive — downloaded straight to
   * `<modelsRoot>/<extractedDir>/<singleFile>`.
   */
  singleFile?: string;
  /**
   * 完整替代 URL(整条换 host 的镜像,如 hf-mirror.com)——`mirrors` 只能做
   * 前缀代理,对 HuggingFace 这类换域名镜像不适用;altUrls 排在主 URL 之前
   * 尝试,保持「国内源优先」的下载顺序。
   */
  altUrls?: string[];
}

/**
 * SenseVoice-Small int8 (zh/yue/en/ja/ko ASR, Apache-2.0) via sherpa-onnx.
 * One model covers the MVP language set with per-token timestamps.
 */
export const SENSEVOICE_MODEL: ModelAsset = {
  id: "sensevoice-2024-07-17",
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2",
  mirrors: [
    // gh proxy services commonly reachable from mainland China; tried in order
    "https://ghfast.top/",
    "https://gh-proxy.com/",
  ],
  extractedDir: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
  // 实测归档体积(2026-07 本机下载验证):999MB,远大于模型本体——进度条按这个才准。
  approxBytes: 1_047_870_769,
};

/**
 * Paraformer-large zh/en int8 (Apache-2.0) via sherpa-onnx — the "more
 * accurate" local tier: noticeably lower zh CER than SenseVoice-Small,
 * per-token timestamps, ~230MB.
 */
export const PARAFORMER_MODEL: ModelAsset = {
  id: "paraformer-zh-2023-09-14",
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-2023-09-14.tar.bz2",
  mirrors: ["https://ghfast.top/", "https://gh-proxy.com/"],
  extractedDir: "sherpa-onnx-paraformer-zh-2023-09-14",
  approxBytes: 240 * 1024 * 1024,
};

/**
 * FireRedASR2-CTC int8 (zh + dialects + en, Apache-2.0, XiaoHongShu 2026-02)
 * via sherpa-onnx — the top-accuracy local tier: ~half the relative error of
 * SenseVoice-Small, per-token timestamps. Needs sherpa-onnx >= 1.12.27.
 */
export const FIRERED_MODEL: ModelAsset = {
  id: "fireredasr2-ctc-2026-02-25",
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25.tar.bz2",
  mirrors: ["https://ghfast.top/", "https://gh-proxy.com/"],
  extractedDir: "sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25",
  approxBytes: 520 * 1024 * 1024,
};

/**
 * YuNet face detector (233KB, MIT, OpenCV zoo) — powers face-aware vertical
 * reframing. Fixed 640×640 input variant (verified decode); tiny enough that
 * downloading is instant even without mirrors.
 */
export const YUNET_MODEL: ModelAsset = {
  id: "yunet-2023mar",
  url: "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
  mirrors: ["https://ghfast.top/", "https://gh-proxy.com/"],
  extractedDir: "yunet-2023mar",
  approxBytes: 233 * 1024,
  singleFile: "model.onnx",
};

/**
 * FER+ 表情识别(VGG13,MIT,onnx/models 官方 validated)——表情峰值信号用:
 * 输入 1×1×64×64 灰度(0-255 原始值),输出 8 类情绪 logits。
 */
export const EMOTION_MODEL: ModelAsset = {
  id: "emotion-ferplus-8",
  url: "https://github.com/onnx/models/raw/main/validated/vision/body_analysis/emotion_ferplus/model/emotion-ferplus-8.onnx",
  mirrors: ["https://ghfast.top/", "https://gh-proxy.com/"],
  extractedDir: "emotion-ferplus-8",
  approxBytes: 34 * 1024 * 1024,
  singleFile: "model.onnx",
};

/**
 * CT-Transformer punctuation (zh/en, int8, Apache-2.0) — Paraformer/FireRed
 * emit no punctuation, which starves sentence segmentation; this restores it.
 */
export const PUNCT_MODEL: ModelAsset = {
  id: "punct-ct-transformer-2024-04-12",
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/punctuation-models/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8.tar.bz2",
  mirrors: ["https://ghfast.top/", "https://gh-proxy.com/"],
  extractedDir: "sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8",
  approxBytes: 65 * 1024 * 1024,
};

/**
 * pyannote segmentation-3.0 ONNX (MIT) — speaker-change detection front-end
 * for diarization. Distributed by sherpa-onnx releases (no HF login needed).
 */
export const SEGMENTATION_MODEL: ModelAsset = {
  id: "pyannote-segmentation-3-0",
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2",
  mirrors: ["https://ghfast.top/", "https://gh-proxy.com/"],
  extractedDir: "sherpa-onnx-pyannote-segmentation-3-0",
  approxBytes: 7 * 1024 * 1024,
};

/**
 * 3D-Speaker ERes2Net base zh embedding (Apache-2.0) — voice fingerprints for
 * clustering diarization segments into speakers. NOTE: the upstream release
 * tag really is spelled "speaker-recongition-models".
 */
export const SPEAKER_EMBEDDING_MODEL: ModelAsset = {
  id: "3dspeaker-eres2net-base-zh",
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx",
  mirrors: ["https://ghfast.top/", "https://gh-proxy.com/"],
  extractedDir: "3dspeaker-eres2net-base-zh",
  approxBytes: 39 * 1024 * 1024,
  singleFile: "model.onnx",
};

/**
 * TransNetV2 镜头边界检测 ONNX(MIT,~31MB)——逐帧输出镜头切换概率,
 * 驱动「切点吸附镜头边界」。输入 float32 [1,100,27,48,3](RGB 0-255),
 * 输出 "534" 为已过 sigmoid 的单帧切换概率(实测硬切 0.98,阈值 0.5)。
 */
export const TRANSNETV2_MODEL: ModelAsset = {
  id: "transnetv2-onnx",
  url: "https://huggingface.co/elya5/transnetv2/resolve/main/transnetv2.onnx",
  mirrors: [],
  altUrls: ["https://hf-mirror.com/elya5/transnetv2/resolve/main/transnetv2.onnx"],
  extractedDir: "transnetv2-onnx",
  approxBytes: 31_250_929,
  singleFile: "model.onnx",
};

export interface DownloadProgress {
  downloadedBytes: number;
  totalBytes: number;
  /**
   * "download" while bytes stream from the network; "extract" while the
   * archive unpacks locally. The in-process bz2 fallback can take minutes on
   * a 1GB archive, so the UI must show it as its own stage, not a stuck 100%.
   */
  phase?: "download" | "extract";
}

/** Candidate URLs in retry order: mirrors first (domestic-first), then origin. */
export function candidateUrls(asset: ModelAsset): string[] {
  return [...asset.mirrors.map((m) => `${m}${asset.url}`), ...(asset.altUrls ?? []), asset.url];
}

/** Absolute path a model extracts to under the given models root. */
export function modelDir(modelsRoot: string, asset: ModelAsset): string {
  return join(modelsRoot, asset.extractedDir);
}

/** True when the model is already present on disk. */
export async function isModelInstalled(modelsRoot: string, asset: ModelAsset): Promise<boolean> {
  try {
    if (asset.singleFile) {
      const s = await stat(join(modelDir(modelsRoot, asset), asset.singleFile));
      return s.isFile() && s.size > 0;
    }
    const s = await stat(modelDir(modelsRoot, asset));
    return s.isDirectory();
  } catch {
    return false;
  }
}

/** 每个 URL 的续传重试次数——大文件断流靠 Range 接着下,而不是从零重来。 */
const RESUME_ATTEMPTS_PER_URL = 3;
/** 重试间隔:给瞬断的网络一口喘息,又不至于让用户干等。 */
const RETRY_DELAY_MS = 1500;

/** 解析 Content-Range "bytes 起-止/总长",失败返回 null。 */
export function parseContentRange(header: string | null): { start: number; total: number } | null {
  const m = /bytes\s+(\d+)-\d+\/(\d+)/.exec(header ?? "");
  if (!m) return null;
  return { start: Number(m[1]), total: Number(m[2]) };
}

/**
 * 单 URL 断点续传下载:失败保留已下字节,下一轮带 Range 接着下。fetch 对
 * GitHub 大文件(SenseVoice 归档 1GB)中途断流是常态,没有续传就是全 mirror
 * 轮番失败(2026-07 本机实测)。206 响应校验起点,镜像谎报即归零重来,
 * 保证部分文件永远不被污染;归档最终还有 tar 解压/体积守卫兜底。
 */
async function downloadResumable(
  url: string,
  archivePath: string,
  asset: ModelAsset,
  onProgress?: (p: DownloadProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < RESUME_ATTEMPTS_PER_URL; attempt++) {
    if (signal?.aborted) throw lastError ?? new Error("aborted");
    if (attempt > 0) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    try {
      let existing = 0;
      try {
        existing = (await stat(archivePath)).size;
      } catch {
        // 没有部分文件:从零开始
      }
      const headers: Record<string, string> = existing > 0 ? { Range: `bytes=${existing}-` } : {};
      const res = await fetch(url, { signal, redirect: "follow", headers });
      // 416:已有字节 ≥ 服务端文件长度,视为下载完成,交给上层校验定生死
      if (res.status === 416) return;
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      let offset = existing;
      let exactTotal: number | null = null;
      if (res.status === 206) {
        const range = parseContentRange(res.headers.get("content-range"));
        if (!range || range.start !== existing) {
          // 镜像谎报续传起点:部分文件不可信,归零重来
          await rm(archivePath, { force: true });
          throw new Error("bad content-range on resume");
        }
        exactTotal = range.total;
      } else {
        // 服务端不支持 Range(返回 200 全量):覆盖写,从头计数
        offset = 0;
      }
      const remaining = Number(res.headers.get("content-length") ?? NaN);
      const totalBytes = exactTotal ?? (Number.isFinite(remaining) ? offset + remaining : asset.approxBytes);

      // 逐块显式写盘(而非 pipeline+WriteStream):断流时已收到的字节一个不丢,
      // 续传起点才与磁盘现状严格一致。
      let downloadedBytes = offset;
      const fh = await open(archivePath, offset > 0 ? "a" : "w");
      try {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await fh.write(value);
          downloadedBytes += value.byteLength;
          onProgress?.({ downloadedBytes, totalBytes, phase: "download" });
        }
      } finally {
        await fh.close();
      }
      return;
    } catch (e) {
      lastError = e;
      if (signal?.aborted) throw e;
      // 部分文件保留:下一轮(或下一个镜像,同一份 release 资产)续传
    }
  }
  throw lastError;
}

/**
 * Extract a .tar.bz2 archive into destDir. System tar first (fast native
 * path on macOS/Linux); pure-JS fallback when it fails — Windows 10/11 ships
 * bsdtar compiled with gzip ONLY, so `tar -xjf` needs an external bzip2
 * program that doesn't exist → deterministic failure on every Windows box
 * (issue #17: 1GB download reached 100%, "corrupt" archive deleted, next
 * mirror re-downloaded from zero, forever). Only when BOTH extractors fail
 * is the archive actually corrupt.
 *
 * `systemTar` is injectable for tests (force the fallback path); pass null
 * to skip system tar entirely.
 */
export async function extractTarBz2(
  archivePath: string,
  destDir: string,
  onProgress?: (p: DownloadProgress) => void,
  systemTar: string | null = "tar"
): Promise<void> {
  const totalBytes = (await stat(archivePath)).size;
  onProgress?.({ downloadedBytes: 0, totalBytes, phase: "extract" });
  if (systemTar) {
    try {
      await execFileAsync(systemTar, ["-xjf", archivePath, "-C", destDir], { maxBuffer: 8 * 1024 * 1024 });
      onProgress?.({ downloadedBytes: totalBytes, totalBytes, phase: "extract" });
      return;
    } catch {
      // fall through to the in-process extractor
    }
  }
  // In-process bz2 → tar. Progress = compressed bytes consumed, so the bar
  // moves honestly through a minutes-long 1GB decompress.
  let read = 0;
  const source = createReadStream(archivePath);
  source.on("data", (chunk) => {
    read += chunk.length;
    onProgress?.({ downloadedBytes: read, totalBytes, phase: "extract" });
  });
  await pipeline(source, unbzip2(), tarExtract({ cwd: destDir }));
}

/**
 * Download + extract a model archive. Tries each candidate URL until one
 * succeeds; writes to a temp file, extracts with system tar (in-process
 * bz2+tar fallback where system tar can't do bzip2 — notably Windows),
 * renames atomically.
 * 断流的部分文件跨镜像保留续传(所有候选 URL 指向同一份资产);用户中途
 * 取消也保留,下次启动接着下。
 */
export async function ensureModel(
  modelsRoot: string,
  asset: ModelAsset,
  onProgress?: (p: DownloadProgress) => void,
  signal?: AbortSignal
): Promise<string> {
  const target = modelDir(modelsRoot, asset);
  if (await isModelInstalled(modelsRoot, asset)) return target;
  await mkdir(modelsRoot, { recursive: true });

  const archivePath = join(modelsRoot, `${asset.id}.download.tar.bz2`);
  let lastError: unknown = null;

  for (const url of candidateUrls(asset)) {
    try {
      await downloadResumable(url, archivePath, asset, onProgress, signal);
    } catch (e) {
      lastError = e;
      if (signal?.aborted) throw e;
      continue; // 网络失败:部分文件留给下一个镜像续传
    }

    try {
      if (asset.singleFile) {
        // guard against Git-LFS pointer files masquerading as the model
        const dl = await stat(archivePath);
        if (dl.size < asset.approxBytes * 0.5) {
          throw new Error(`downloaded file too small (${dl.size}B) — likely an LFS pointer`);
        }
        // raw file: move into place atomically
        await mkdir(target, { recursive: true });
        await rename(archivePath, join(target, asset.singleFile));
      } else {
        // 解压进 staging 目录再原子 rename:进程被杀/解压失败都不会留下
        // 会被 isModelInstalled 误判为「已安装」的残缺模型目录。
        const staging = join(modelsRoot, `${asset.id}.extracting`);
        await rm(staging, { recursive: true, force: true });
        await mkdir(staging, { recursive: true });
        try {
          await extractTarBz2(archivePath, staging, onProgress);
          const produced = join(staging, asset.extractedDir);
          if (!(await stat(produced).catch(() => null))?.isDirectory()) {
            throw new Error(`archive did not contain expected dir ${asset.extractedDir}`);
          }
          await rm(target, { recursive: true, force: true });
          await rename(produced, target);
        } finally {
          await rm(staging, { recursive: true, force: true });
        }
        await rm(archivePath, { force: true });
      }
      if (!(await isModelInstalled(modelsRoot, asset))) {
        throw new Error(`archive did not contain expected dir ${asset.extractedDir}`);
      }
      return target;
    } catch (e) {
      lastError = e;
      // 下载完但两路解压都失败:文件真损坏,归零后换下一个镜像重来
      await rm(archivePath, { force: true });
      if (signal?.aborted) throw e;
    }
  }

  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`model download failed after all mirrors (${asset.id}): ${msg}`);
}

/**
 * 从任意媒体抽出 16k 单声道 raw f32le 样本文件(ASR 引擎直接消费)。
 * 不出 wav 再让 sherpa readWave 去开文件:原生层在 Windows 上按 ANSI 开路径,
 * 中文用户名下的临时目录一律打不开(issue #4)。raw 样本由 Node 侧读入内存
 * (fs 对 Unicode 路径免疫),原生层只见到内存里的 Float32Array。
 */
export async function extractPcmF32le16k(
  ffmpegPath: string,
  inputPath: string,
  outputPath: string,
  range?: { startSec: number; durationSec: number }
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  const tmp = `${outputPath}.tmp.f32le`;
  await execFileAsync(
    ffmpegPath,
    [
      "-hide_banner", "-y",
      // 范围抽取(精对齐只解码候选段):-ss 在 -i 前快速跳转,-t 截取时长
      ...(range ? ["-ss", String(Math.max(0, range.startSec))] : []),
      "-i", inputPath,
      ...(range ? ["-t", String(Math.max(0.1, range.durationSec))] : []),
      "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-c:a", "pcm_f32le", tmp,
    ],
    { maxBuffer: 32 * 1024 * 1024 }
  );
  await rename(tmp, outputPath);
}

/** 读 raw f32le 样本进内存。Buffer 的 byteOffset 不保证 4 字节对齐,拷进新 ArrayBuffer 再套 Float32Array。 */
export async function readF32leSamples(path: string): Promise<Float32Array> {
  const buf = await readFile(path);
  const bytes = buf.byteLength - (buf.byteLength % 4);
  const aligned = new ArrayBuffer(bytes);
  new Uint8Array(aligned).set(buf.subarray(0, bytes));
  return new Float32Array(aligned);
}
