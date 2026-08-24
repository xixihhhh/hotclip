/**
 * Network-video source import. The downloader itself is fetched on first use
 * as an official self-contained yt-dlp release asset and verified against the
 * release SHA-256 manifest. Downloaded media then enters the normal local-file
 * probe/transcribe/export pipeline.
 */
import { createHash } from "crypto";
import { spawn } from "child_process";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { isIP } from "net";
import { basename, join, relative, resolve, sep } from "path";
import { resolveFfmpegPath } from "./binaries";
import type { UrlImportProgressEvent, UrlImportResult } from "../shared/api-types";

const RELEASE_BASE = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
const SHA_FILE = "SHA2-256SUMS";

export interface UrlImportOptions {
  toolsDir: string;
  destDir: string;
  signal?: AbortSignal;
  onProgress?: (event: UrlImportProgressEvent) => void;
  fetchImpl?: typeof fetch;
}

export function ytDlpAsset(platform = process.platform, arch = process.arch): string {
  if (platform === "darwin") return "yt-dlp_macos";
  if (platform === "win32") return "yt-dlp.exe";
  if (platform === "linux" && arch === "x64") return "yt-dlp_linux";
  if (platform === "linux" && arch === "arm64") return "yt-dlp_linux_aarch64";
  throw new Error(`URL import is not available on ${platform}/${arch}`);
}

function isPrivateIpv4(host: string): boolean {
  const p = host.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  return (
    p[0] === 0 || p[0] === 10 || p[0] === 127 ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) || p[0] >= 224
  );
}

function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase();
  return h === "::" || h === "::1" || h.startsWith("fc") || h.startsWith("fd") || /^fe[89ab]/.test(h);
}

/** Accept only ordinary public HTTP(S) URLs; never pass file/custom schemes or local endpoints to yt-dlp. */
export function validateMediaUrl(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error("Enter a video URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid video URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only HTTP(S) video URLs are supported");
  if (url.username || url.password) throw new Error("Video URLs containing credentials are not supported");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error("Local network video URLs are not supported");
  }
  const family = isIP(host);
  if ((family === 4 && isPrivateIpv4(host)) || (family === 6 && isPrivateIpv6(host))) {
    throw new Error("Local network video URLs are not supported");
  }
  return url.toString();
}

async function sha256(path: string): Promise<string> {
  const handle = await open(path, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

export function checksumForAsset(manifest: string, asset: string): string {
  for (const line of manifest.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match && basename(match[2]) === asset) return match[1].toLowerCase();
  }
  throw new Error(`yt-dlp checksum is missing for ${asset}`);
}

async function fetchChecked(fetchImpl: typeof fetch, url: string, signal?: AbortSignal): Promise<Response> {
  const response = await fetchImpl(url, { redirect: "follow", signal });
  if (!response.ok) throw new Error(`yt-dlp download failed (HTTP ${response.status})`);
  return response;
}

async function downloadFile(
  response: Response,
  path: string,
  onProgress?: (downloaded: number, total?: number) => void,
  signal?: AbortSignal
): Promise<void> {
  if (!response.body) throw new Error("yt-dlp download returned an empty body");
  const totalHeader = Number(response.headers.get("content-length"));
  const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : undefined;
  const handle = await open(path, "w");
  const reader = response.body.getReader();
  let downloaded = 0;
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      await handle.write(value);
      downloaded += value.byteLength;
      onProgress?.(downloaded, total);
    }
  } finally {
    await reader.cancel().catch(() => {});
    await handle.close();
  }
  if (downloaded === 0) throw new Error("yt-dlp download returned an empty file");
}

export async function ensureYtDlp(opts: UrlImportOptions): Promise<string> {
  const asset = ytDlpAsset();
  const binaryPath = join(opts.toolsDir, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
  const checksumPath = `${binaryPath}.sha256`;
  await mkdir(opts.toolsDir, { recursive: true });

  const [savedChecksum, binaryInfo] = await Promise.all([
    readFile(checksumPath, "utf8").catch(() => ""),
    stat(binaryPath).catch(() => null),
  ]);
  if (binaryInfo?.isFile() && savedChecksum.trim()) {
    if ((await sha256(binaryPath)) === savedChecksum.trim().toLowerCase()) return binaryPath;
    await Promise.all([rm(binaryPath, { force: true }), rm(checksumPath, { force: true })]);
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const manifestResponse = await fetchChecked(fetchImpl, `${RELEASE_BASE}/${SHA_FILE}`, opts.signal);
  const expected = checksumForAsset(await manifestResponse.text(), asset);
  const tempPath = `${binaryPath}.part`;
  let lastProgressAt = 0;
  await rm(tempPath, { force: true });
  try {
    const binaryResponse = await fetchChecked(fetchImpl, `${RELEASE_BASE}/${asset}`, opts.signal);
    await downloadFile(
      binaryResponse,
      tempPath,
      (downloadedBytes, totalBytes) => {
        const now = Date.now();
        if (now - lastProgressAt < 100 && downloadedBytes !== totalBytes) return;
        lastProgressAt = now;
        opts.onProgress?.({
          stage: "downloading-tool",
          downloadedBytes,
          totalBytes,
          fraction: totalBytes ? downloadedBytes / totalBytes : undefined,
        });
      },
      opts.signal
    );
    const actual = await sha256(tempPath);
    if (actual !== expected) throw new Error("yt-dlp checksum verification failed");
    if (process.platform !== "win32") await chmod(tempPath, 0o755);
    await rename(tempPath, binaryPath);
    await writeFile(checksumPath, `${expected}\n`, "utf8");
    return binaryPath;
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

export function parseYtDlpProgress(line: string): UrlImportProgressEvent | null {
  const match = line.match(/hotclip-progress:\s*([\d.]+)%?\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)/);
  if (!match) return null;
  const number = (value: string): number | undefined => {
    const n = Number(value.trim());
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const percent = number(match[1]);
  const downloadedBytes = number(match[2]);
  const totalBytes = number(match[3]);
  return {
    stage: "downloading-media",
    fraction: percent === undefined ? undefined : Math.min(1, percent / 100),
    downloadedBytes,
    totalBytes,
    speedBytesPerSec: number(match[4]),
    etaSec: number(match[5]),
  };
}

/** Download one URL (never a playlist), merge to MP4 when needed, and return its verified local path. */
export async function importMediaUrl(input: string, opts: UrlImportOptions): Promise<UrlImportResult> {
  const url = validateMediaUrl(input);
  await mkdir(opts.destDir, { recursive: true });
  const binary = await ensureYtDlp(opts);
  if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  opts.onProgress?.({ stage: "resolving" });

  const outputTemplate = join(opts.destDir, "%(title).160B [%(id)s].%(ext)s");
  const args = [
    "--newline",
    "--progress",
    "--progress-delta", "0.2",
    "--no-playlist",
    "--continue",
    "--no-overwrites",
    "--retries", "10",
    "--fragment-retries", "10",
    "--windows-filenames",
    "--trim-filenames", "180",
    "--format", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
    "--merge-output-format", "mp4",
    "--ffmpeg-location", resolveFfmpegPath(),
    "--progress-template", "download:hotclip-progress:%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s",
    "--print", "after_move:hotclip-result:%(filepath)s",
    "--output", outputTemplate,
    url,
  ];

  const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
  let outputPath = "";
  let tail = "";
  let lineBuffer = "";
  const consume = (chunk: Buffer | string): void => {
    lineBuffer += chunk.toString();
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const progress = parseYtDlpProgress(line);
      if (progress) opts.onProgress?.(progress);
      if (line.startsWith("hotclip-result:")) outputPath = line.slice("hotclip-result:".length).trim();
      if (/\[(?:Merger|VideoRemuxer|Fixup)/.test(line)) opts.onProgress?.({ stage: "merging" });
      if (line.trim()) tail = `${tail}\n${line.trim()}`.slice(-8000);
    }
  };
  child.stdout.on("data", consume);
  child.stderr.on("data", consume);

  const abort = (): void => {
    child.kill("SIGTERM");
  };
  opts.signal?.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((resolveClose, rejectClose) => {
      child.once("error", rejectClose);
      child.once("close", (code) => {
        consume("\n");
        if (opts.signal?.aborted) rejectClose(new DOMException("Aborted", "AbortError"));
        else if (code === 0) resolveClose();
        else rejectClose(new Error((tail.trim() || `yt-dlp exited with code ${code}`).replaceAll(url, "<URL>")));
      });
    });
  } finally {
    opts.signal?.removeEventListener("abort", abort);
  }

  if (!outputPath) throw new Error("yt-dlp finished without returning a media path");
  const absolute = resolve(outputPath);
  const root = resolve(opts.destDir);
  const within = relative(root, absolute);
  if (!within || within.startsWith(`..${sep}`) || within === "..") throw new Error("yt-dlp returned an unsafe media path");
  const info = await stat(absolute);
  if (!info.isFile() || info.size === 0) throw new Error("Downloaded media file is empty");
  opts.onProgress?.({ stage: "done", fraction: 1 });
  return { filePath: absolute };
}
