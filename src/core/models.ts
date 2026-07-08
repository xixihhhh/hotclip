/**
 * Local AI model management: registry + first-run download with mirror
 * fallback (GitHub is slow/unreachable for many Chinese users, so every
 * asset lists proxy mirrors tried in order).
 *
 * Models live OUTSIDE the app bundle (user data dir) so app updates never
 * re-download them and the installer stays small.
 */
import { createWriteStream } from "fs";
import { mkdir, rename, rm, stat } from "fs/promises";
import { join, dirname } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

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
  approxBytes: 170 * 1024 * 1024,
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

/**
 * Download + extract a model archive. Tries each candidate URL until one
 * succeeds; writes to a temp file, extracts with system tar (bsdtar ships
 * with Windows 10+, macOS and virtually every Linux), renames atomically.
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
      const res = await fetch(url, { signal, redirect: "follow" });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const totalBytes = Number(res.headers.get("content-length") ?? asset.approxBytes);
      let downloadedBytes = 0;

      const counter = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          downloadedBytes += chunk.byteLength;
          onProgress?.({ downloadedBytes, totalBytes });
          controller.enqueue(chunk);
        },
      });

      await rm(archivePath, { force: true });
      await pipeline(
        Readable.fromWeb(res.body.pipeThrough(counter) as import("stream/web").ReadableStream),
        createWriteStream(archivePath),
        { signal }
      );

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
        // extract next to the archive, then verify the expected folder appeared
        await execFileAsync("tar", ["-xjf", archivePath, "-C", modelsRoot], { maxBuffer: 8 * 1024 * 1024 });
        await rm(archivePath, { force: true });
      }
      if (!(await isModelInstalled(modelsRoot, asset))) {
        throw new Error(`archive did not contain expected dir ${asset.extractedDir}`);
      }
      return target;
    } catch (e) {
      lastError = e;
      await rm(archivePath, { force: true });
      if (signal?.aborted) throw e;
      // fall through to the next mirror
    }
  }

  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`model download failed after all mirrors (${asset.id}): ${msg}`);
}

/** Extract mono 16k PCM wav from any media file (what ASR engines consume). */
export async function extractWav16k(
  ffmpegPath: string,
  inputPath: string,
  outputPath: string
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  const tmp = `${outputPath}.tmp.wav`;
  await execFileAsync(
    ffmpegPath,
    ["-hide_banner", "-y", "-i", inputPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", tmp],
    { maxBuffer: 32 * 1024 * 1024 }
  );
  await rename(tmp, outputPath);
}
