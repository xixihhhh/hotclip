/**
 * Small, source-derived evidence cache shared by desktop, CLI, MCP, and
 * unattended jobs. Entries are JSON-only and capability-scoped: adding or
 * changing one detector never invalidates unrelated evidence.
 */
import { createHash, randomUUID } from "crypto";
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "fs/promises";
import { resolve } from "path";
import { fingerprintRenderFile, type FileFingerprint } from "./render-cache";

export const EVIDENCE_INDEX_VERSION = 1;
export const DEFAULT_EVIDENCE_INDEX_MAX_BYTES = 64 * 1024 * 1024;
export const MAX_EVIDENCE_ENTRY_BYTES = 8 * 1024 * 1024;
const PARTIAL_ENTRY_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface EvidenceIndexStats {
  bytes: number;
  entries: number;
}

interface EvidenceEntry<T> {
  version: typeof EVIDENCE_INDEX_VERSION;
  source: FileFingerprint;
  capability: string;
  createdAt: string;
  value: T;
}

export async function fingerprintEvidenceSource(filePath: string): Promise<FileFingerprint> {
  return fingerprintRenderFile(filePath);
}

function canonicalSource(source: FileFingerprint): string {
  return `${resolve(source.path)}\n${source.size}\n${Math.round(source.mtimeMs)}`;
}

export function evidenceSourceId(source: FileFingerprint): string {
  return createHash("sha256").update(canonicalSource(source)).digest("hex");
}

export function createEvidenceEntryKey(source: FileFingerprint, capability: string): string {
  return createHash("sha256")
    .update(`hotclip-evidence-v${EVIDENCE_INDEX_VERSION}\n`)
    .update(canonicalSource(source))
    .update("\n")
    .update(capability)
    .digest("hex");
}

function entryPath(dir: string, source: FileFingerprint, capability: string): string {
  return resolve(dir, `${createEvidenceEntryKey(source, capability)}.json`);
}

function sameSource(a: FileFingerprint, b: FileFingerprint): boolean {
  return resolve(a.path) === resolve(b.path) && a.size === b.size && Math.round(a.mtimeMs) === Math.round(b.mtimeMs);
}

function validCapability(capability: string): boolean {
  return capability.length > 0 && capability.length <= 512 && !/[\u0000-\u001f]/.test(capability);
}

export async function readEvidence<T>(
  dir: string,
  source: FileFingerprint,
  capability: string,
  validate: (value: unknown) => value is T
): Promise<T | undefined> {
  if (!validCapability(capability)) return undefined;
  const path = entryPath(dir, source, capability);
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size <= 0 || info.size > MAX_EVIDENCE_ENTRY_BYTES) {
      await rm(path, { force: true });
      return undefined;
    }
    const entry = JSON.parse(await readFile(path, "utf8")) as Partial<EvidenceEntry<unknown>>;
    if (
      entry.version !== EVIDENCE_INDEX_VERSION ||
      entry.capability !== capability ||
      !entry.source ||
      !sameSource(entry.source, source) ||
      !validate(entry.value)
    ) {
      await rm(path, { force: true });
      return undefined;
    }
    const now = new Date();
    await utimes(path, now, now).catch(() => undefined);
    return entry.value;
  } catch {
    // Missing, corrupt, or concurrently pruned entries are normal cache misses.
    return undefined;
  }
}

async function removeStalePartials(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const now = Date.now();
  await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.includes(".tmp-")).map(async (entry) => {
    const path = resolve(dir, entry.name);
    const info = await stat(path).catch(() => null);
    if (info && now - info.mtimeMs >= PARTIAL_ENTRY_MAX_AGE_MS) await rm(path, { force: true });
  }));
}

export async function inspectEvidenceIndex(dir: string): Promise<EvidenceIndexStats> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  let bytes = 0;
  let count = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const info = await stat(resolve(dir, entry.name)).catch(() => null);
    if (!info || info.size <= 0) continue;
    bytes += info.size;
    count += 1;
  }
  return { bytes, entries: count };
}

export async function pruneEvidenceIndex(
  dir: string,
  maxBytes = DEFAULT_EVIDENCE_INDEX_MAX_BYTES
): Promise<EvidenceIndexStats> {
  await removeStalePartials(dir);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = resolve(dir, entry.name);
    const info = await stat(path).catch(() => null);
    if (!info || info.size <= 0 || info.size > MAX_EVIDENCE_ENTRY_BYTES) await rm(path, { force: true }).catch(() => undefined);
    else files.push({ path, size: info.size, mtimeMs: info.mtimeMs });
  }
  files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DEFAULT_EVIDENCE_INDEX_MAX_BYTES;
  let bytes = files.reduce((sum, file) => sum + file.size, 0);
  let count = files.length;
  for (const file of files) {
    if (bytes <= limit) break;
    try {
      await rm(file.path, { force: true });
      bytes -= file.size;
      count -= 1;
    } catch {
      // Best effort; another process may have touched the entry.
    }
  }
  return { bytes: Math.max(0, bytes), entries: Math.max(0, count) };
}

export async function writeEvidence<T>(
  dir: string,
  source: FileFingerprint,
  capability: string,
  value: T,
  maxBytes = DEFAULT_EVIDENCE_INDEX_MAX_BYTES
): Promise<boolean> {
  if (!validCapability(capability)) return false;
  const payload = JSON.stringify({
    version: EVIDENCE_INDEX_VERSION,
    source,
    capability,
    createdAt: new Date().toISOString(),
    value,
  } satisfies EvidenceEntry<T>);
  if (Buffer.byteLength(payload) > MAX_EVIDENCE_ENTRY_BYTES) return false;
  await mkdir(dir, { recursive: true });
  const target = entryPath(dir, source, capability);
  const temp = resolve(dir, `${createEvidenceEntryKey(source, capability)}.json.tmp-${process.pid}-${randomUUID()}`);
  try {
    await writeFile(temp, payload, "utf8");
    try {
      // POSIX rename replaces atomically. Windows may reject replacement, so
      // keep the remove-then-rename gap as a narrow compatibility fallback.
      await rename(temp, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM") throw error;
      await rm(target, { force: true });
      await rename(temp, target);
    }
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
  await pruneEvidenceIndex(dir, maxBytes);
  return true;
}

/** Clear only regenerable analysis evidence. Media, projects, models, transcripts, and renders are untouched. */
export async function clearEvidenceIndex(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
}
