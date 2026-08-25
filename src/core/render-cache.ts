/**
 * Bounded cache for exact, reusable base renders. Cache entries are always
 * copied back into the export workspace: later passes may replace the working
 * file, so hard links would risk mutating the cached artifact.
 */
import { createHash, randomUUID } from "crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, utimes } from "fs/promises";
import { resolve } from "path";

export const RENDER_CACHE_VERSION = 1;
export const DEFAULT_RENDER_CACHE_MAX_BYTES = 1024 * 1024 * 1024;
const PARTIAL_ENTRY_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface FileFingerprint {
  path: string;
  size: number;
  mtimeMs: number;
  sha256?: string;
}

export interface RenderCacheStats {
  bytes: number;
  entries: number;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item ?? null)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

/** Stable across object key insertion order; versioned so renderer changes invalidate old entries. */
export function createRenderCacheKey(input: unknown): string {
  return createHash("sha256")
    .update(`hotclip-render-cache-v${RENDER_CACHE_VERSION}\n`)
    .update(canonicalJson(input))
    .digest("hex");
}

export function hashRenderInput(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

/** File identity used in keys. Content hashing is reserved for small text inputs such as ASS. */
export async function fingerprintRenderFile(filePath: string, hashContents = false): Promise<FileFingerprint> {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error(`render cache input is not a file: ${filePath}`);
  return {
    path: resolve(filePath),
    size: info.size,
    mtimeMs: info.mtimeMs,
    ...(hashContents ? { sha256: hashRenderInput(await readFile(filePath)) } : {}),
  };
}

function entryPath(cacheDir: string, key: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(key)) throw new Error("invalid render cache key");
  return resolve(cacheDir, `${key}.mp4`);
}

async function removePartialEntries(cacheDir: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(cacheDir, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.includes(".tmp-"))
      .map(async (entry) => {
        const path = resolve(cacheDir, entry.name);
        const info = await stat(path).catch(() => null);
        // Fresh temp files may belong to another export. Only reap leftovers
        // old enough that they cannot be a normal in-flight base render.
        if (info && now - info.mtimeMs >= PARTIAL_ENTRY_MAX_AGE_MS) await rm(path, { force: true });
      })
  );
}

export async function inspectRenderCache(cacheDir: string): Promise<RenderCacheStats> {
  let entries;
  try {
    entries = await readdir(cacheDir, { withFileTypes: true });
  } catch {
    return { bytes: 0, entries: 0 };
  }
  let bytes = 0;
  let count = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".mp4")) continue;
    try {
      const info = await stat(resolve(cacheDir, entry.name));
      if (info.size <= 0) continue;
      bytes += info.size;
      count += 1;
    } catch {
      // A concurrent export may replace/prune an entry; the next inspection sees the final state.
    }
  }
  return { bytes, entries: count };
}

/** Restore a cache hit into an independent file and mark the entry as recently used. */
export async function restoreRenderCache(cacheDir: string, key: string, outputPath: string): Promise<boolean> {
  const source = entryPath(cacheDir, key);
  try {
    const info = await stat(source);
    if (!info.isFile() || info.size <= 0) {
      await rm(source, { force: true });
      return false;
    }
    await copyFile(source, outputPath);
    const now = new Date();
    await utimes(source, now, now).catch(() => undefined);
    return true;
  } catch {
    await rm(outputPath, { force: true }).catch(() => undefined);
    return false;
  }
}

export async function invalidateRenderCache(cacheDir: string, key: string): Promise<void> {
  await rm(entryPath(cacheDir, key), { force: true });
}

/** Remove least-recently-used completed entries and stale interrupted temp writes. */
export async function pruneRenderCache(
  cacheDir: string,
  maxBytes = DEFAULT_RENDER_CACHE_MAX_BYTES
): Promise<RenderCacheStats> {
  await removePartialEntries(cacheDir);
  let entries;
  try {
    entries = await readdir(cacheDir, { withFileTypes: true });
  } catch {
    return { bytes: 0, entries: 0 };
  }
  const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".mp4")) continue;
    const path = resolve(cacheDir, entry.name);
    try {
      const info = await stat(path);
      if (info.size <= 0) await rm(path, { force: true });
      else files.push({ path, size: info.size, mtimeMs: info.mtimeMs });
    } catch {
      // Concurrent cache activity is harmless.
    }
  }
  files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  let bytes = files.reduce((sum, file) => sum + file.size, 0);
  let count = files.length;
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DEFAULT_RENDER_CACHE_MAX_BYTES;
  for (const file of files) {
    if (bytes <= limit) break;
    try {
      await rm(file.path, { force: true });
      bytes -= file.size;
      count -= 1;
    } catch {
      // Best effort; a later prune retries.
    }
  }
  return { bytes: Math.max(0, bytes), entries: Math.max(0, count) };
}

/** Atomically publish a completed base render, then enforce the cache budget. */
export async function storeRenderCache(
  cacheDir: string,
  key: string,
  sourcePath: string,
  maxBytes = DEFAULT_RENDER_CACHE_MAX_BYTES
): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  const target = entryPath(cacheDir, key);
  const existing = await stat(target).catch(() => null);
  if (existing?.isFile() && existing.size > 0) {
    const now = new Date();
    await utimes(target, now, now).catch(() => undefined);
    await pruneRenderCache(cacheDir, maxBytes);
    return;
  }
  const temp = resolve(cacheDir, `${key}.mp4.tmp-${process.pid}-${randomUUID()}`);
  try {
    await copyFile(sourcePath, temp);
    const copied = await stat(temp);
    if (!copied.isFile() || copied.size <= 0) throw new Error("render cache refused an empty artifact");
    await rm(target, { force: true });
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
  await pruneRenderCache(cacheDir, maxBytes);
}

/** Clear only generated base renders. User projects, media, models, and transcript cache are untouched. */
export async function clearRenderCache(cacheDir: string): Promise<void> {
  await rm(cacheDir, { recursive: true, force: true });
  await mkdir(cacheDir, { recursive: true });
}
