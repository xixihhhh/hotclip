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

export interface DownloadProgress {
  downloadedBytes: number;
  totalBytes: number;
}

/** Candidate URLs in retry order: mirrors first (domestic-first), then origin. */
export function candidateUrls(asset: ModelAsset): string[] {
  return [...asset.mirrors.map((m) => `${m}${asset.url}`), asset.url];
}

/** Absolute path a model extracts to under the given models root. */
export function modelDir(modelsRoot: string, asset: ModelAsset): string {
  return join(modelsRoot, asset.extractedDir);
}

/** True when the model is already present on disk. */
export async function isModelInstalled(modelsRoot: string, asset: ModelAsset): Promise<boolean> {
  try {
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

      // extract next to the archive, then verify the expected folder appeared
      await execFileAsync("tar", ["-xjf", archivePath, "-C", modelsRoot], { maxBuffer: 8 * 1024 * 1024 });
      await rm(archivePath, { force: true });
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
