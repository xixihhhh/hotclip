/**
 * Persistent transcript cache. Transcription is by far the slowest step, so a
 * user who re-opens the app to cut more clips from the same file should never
 * pay for it twice. Entries are keyed by (path, size, mtime, engine) — an edit
 * to the file changes size/mtime and misses; a new engine misses. Every op is
 * best-effort: a cache fault must never block or corrupt a real transcription.
 */
import { readFile, writeFile, mkdir, readdir, stat, rm } from "fs/promises";
import { join } from "path";
import type { Transcript } from "../../shared/api-types";

/** Bump when the Transcript shape or engine output changes so stale entries miss. */
export const TRANSCRIPT_CACHE_VERSION = 1;
/** Cap the cache; the oldest entries are pruned on write so it can't grow forever. */
const MAX_CACHE_ENTRIES = 60;

/**
 * FNV-1a over the absolute path → base36. Folds the path into the filename so
 * two different files that happen to share size+mtime can't collide.
 */
function pathHash(filePath: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < filePath.length; i++) {
    h ^= filePath.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** Deterministic cache filename for one (file version, engine) pair. Pure. */
export function transcriptCacheFilename(
  filePath: string,
  sizeBytes: number,
  mtimeMs: number,
  engineId: string
): string {
  const eng = engineId.replace(/[^a-z0-9]+/gi, "").toLowerCase() || "asr";
  return `${pathHash(filePath)}_${eng}_${sizeBytes}_${Math.round(mtimeMs)}_v${TRANSCRIPT_CACHE_VERSION}.json`;
}

/** A cached transcript for this exact file+engine, or undefined on any miss. */
export async function readTranscriptCache(
  dir: string,
  filePath: string,
  fileStat: { size: number; mtimeMs: number },
  engineId: string
): Promise<Transcript | undefined> {
  try {
    const p = join(dir, transcriptCacheFilename(filePath, fileStat.size, fileStat.mtimeMs, engineId));
    const t = JSON.parse(await readFile(p, "utf8")) as Transcript;
    if (t && Array.isArray(t.segments)) return t;
  } catch {
    /* miss / unreadable / bad JSON → recompute */
  }
  return undefined;
}

/** Store a transcript; best-effort, prunes the cache afterwards. */
export async function writeTranscriptCache(
  dir: string,
  filePath: string,
  fileStat: { size: number; mtimeMs: number },
  engineId: string,
  transcript: Transcript
): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    const p = join(dir, transcriptCacheFilename(filePath, fileStat.size, fileStat.mtimeMs, engineId));
    await writeFile(p, JSON.stringify(transcript), "utf8");
    await pruneCache(dir, MAX_CACHE_ENTRIES);
  } catch {
    /* cache write is best-effort; never block transcription */
  }
}

/** Keep only the newest `maxEntries` cache files by mtime; delete the rest. */
export async function pruneCache(dir: string, maxEntries: number): Promise<void> {
  try {
    const names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
    if (names.length <= maxEntries) return;
    const withTimes = await Promise.all(
      names.map(async (n) => ({ n, m: (await stat(join(dir, n))).mtimeMs }))
    );
    withTimes.sort((a, b) => b.m - a.m); // newest first
    await Promise.all(withTimes.slice(maxEntries).map(({ n }) => rm(join(dir, n), { force: true })));
  } catch {
    /* prune is best-effort */
  }
}
