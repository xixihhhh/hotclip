import { randomUUID } from "crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "fs/promises";
import { basename, dirname, extname, join } from "path";
import type {
  MediaInfo,
  ProjectOpenResult,
  ProjectSourceStatus,
  ProjectSummary,
  ProjectWorkspaceBootstrap,
  SessionCheckpoint,
} from "../shared/api-types";
import {
  clearSessionCheckpoint,
  normalizeSessionCheckpoint,
  readSessionCheckpoint,
  SESSION_CHECKPOINT_MAX_BYTES,
} from "./session-checkpoint";

const INDEX_VERSION = 1;
const PROJECT_VERSION = 1;
const PROJECT_DIR = "projects";
const INDEX_FILE = "index.json";
const LEGACY_PROJECT_ID = "legacy-active-session";
const INDEX_MAX_BYTES = 2 * 1024 * 1024;
const PROJECT_NAME_MAX = 80;
export const PROJECT_WORKSPACE_MAX_PROJECTS = 200;

interface ProjectSourceFingerprint {
  path: string;
  size: number;
  mtimeMs: number;
}

interface ProjectIndexEntry {
  id: string;
  name: string;
  source: ProjectSourceFingerprint;
  sourceName: string;
  hasTranscript: boolean;
  candidateCount: number;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
}

interface StoredProjectIndex {
  version: typeof INDEX_VERSION;
  activeProjectId: string | null;
  projects: ProjectIndexEntry[];
}

interface StoredProjectDocument {
  version: typeof PROJECT_VERSION;
  id: string;
  name: string;
  source: ProjectSourceFingerprint;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
  checkpoint: SessionCheckpoint;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const validDate = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
const validProjectId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value);

function workspaceDir(userDataDir: string): string {
  return join(userDataDir, PROJECT_DIR);
}

function indexPath(userDataDir: string): string {
  return join(workspaceDir(userDataDir), INDEX_FILE);
}

function projectPath(userDataDir: string, id: string): string {
  if (!validProjectId(id)) throw new Error("invalid project id");
  return join(workspaceDir(userDataDir), `${id}.hotclip`);
}

function normalizeProjectName(value: unknown, fallback: string): string {
  const cleaned = typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
    : "";
  return (cleaned || fallback || "Untitled project").slice(0, PROJECT_NAME_MAX);
}

function sourceDisplayName(path: string): string {
  const file = basename(path);
  const extension = extname(file);
  return extension ? file.slice(0, -extension.length) : file;
}

function validSource(value: unknown): value is ProjectSourceFingerprint {
  return isObject(value) && typeof value.path === "string" && value.path.length > 0 &&
    finite(value.size) && value.size >= 0 && finite(value.mtimeMs) && value.mtimeMs >= 0;
}

function normalizeIndexEntry(value: unknown): ProjectIndexEntry | null {
  if (!isObject(value) || !validProjectId(value.id) || typeof value.name !== "string" ||
      !validSource(value.source) || typeof value.sourceName !== "string" ||
      typeof value.hasTranscript !== "boolean" || !finite(value.candidateCount) || value.candidateCount < 0 ||
      !validDate(value.createdAt) || !validDate(value.updatedAt) || !validDate(value.lastOpenedAt)) return null;
  return {
    id: value.id,
    name: normalizeProjectName(value.name, sourceDisplayName(value.source.path)),
    source: value.source,
    sourceName: value.sourceName.slice(0, 255),
    hasTranscript: value.hasTranscript,
    candidateCount: Math.floor(value.candidateCount),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    lastOpenedAt: value.lastOpenedAt,
  };
}

function normalizeIndex(value: unknown): StoredProjectIndex | null {
  if (!isObject(value) || value.version !== INDEX_VERSION ||
      (value.activeProjectId !== null && !validProjectId(value.activeProjectId)) || !Array.isArray(value.projects)) return null;
  const projects: ProjectIndexEntry[] = [];
  const ids = new Set<string>();
  for (const raw of value.projects) {
    const entry = normalizeIndexEntry(raw);
    if (!entry || ids.has(entry.id)) return null;
    ids.add(entry.id);
    projects.push(entry);
  }
  if (projects.length > PROJECT_WORKSPACE_MAX_PROJECTS) return null;
  const activeProjectId = typeof value.activeProjectId === "string" && ids.has(value.activeProjectId)
    ? value.activeProjectId
    : null;
  return { version: INDEX_VERSION, activeProjectId, projects };
}

function normalizeDocument(value: unknown): StoredProjectDocument | null {
  if (!isObject(value) || value.version !== PROJECT_VERSION || !validProjectId(value.id) ||
      typeof value.name !== "string" || !validSource(value.source) ||
      !validDate(value.createdAt) || !validDate(value.updatedAt) || !validDate(value.lastOpenedAt)) return null;
  const checkpoint = normalizeSessionCheckpoint(value.checkpoint);
  if (!checkpoint || checkpoint.file.path !== value.source.path) return null;
  return {
    version: PROJECT_VERSION,
    id: value.id,
    name: normalizeProjectName(value.name, sourceDisplayName(value.source.path)),
    source: value.source,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    lastOpenedAt: value.lastOpenedAt,
    checkpoint,
  };
}

async function removeQuietly(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function atomicWrite(path: string, value: unknown, maxBytes: number): Promise<boolean> {
  const payload = JSON.stringify(value);
  if (Buffer.byteLength(payload) > maxBytes) return false;
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, payload, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
  return true;
}

async function readProjectDocument(userDataDir: string, id: string): Promise<StoredProjectDocument | null> {
  try {
    const raw = await readFile(projectPath(userDataDir, id));
    if (raw.byteLength > SESSION_CHECKPOINT_MAX_BYTES) return null;
    return normalizeDocument(JSON.parse(raw.toString("utf8")) as unknown);
  } catch {
    return null;
  }
}

function indexEntryFromDocument(document: StoredProjectDocument): ProjectIndexEntry {
  return {
    id: document.id,
    name: document.name,
    source: document.source,
    sourceName: basename(document.source.path),
    hasTranscript: document.checkpoint.transcript !== null,
    candidateCount: document.checkpoint.candidates?.length ?? 0,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    lastOpenedAt: document.lastOpenedAt,
  };
}

async function rebuildIndex(userDataDir: string): Promise<StoredProjectIndex> {
  const dir = workspaceDir(userDataDir);
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const projects: ProjectIndexEntry[] = [];
  for (const name of names.filter((item) => item.endsWith(".hotclip")).slice(0, PROJECT_WORKSPACE_MAX_PROJECTS)) {
    const id = name.slice(0, -".hotclip".length);
    if (!validProjectId(id)) continue;
    const document = await readProjectDocument(userDataDir, id);
    if (document) projects.push(indexEntryFromDocument(document));
  }
  projects.sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
  const rebuilt: StoredProjectIndex = { version: INDEX_VERSION, activeProjectId: null, projects };
  await atomicWrite(indexPath(userDataDir), rebuilt, INDEX_MAX_BYTES);
  return rebuilt;
}

async function readIndex(userDataDir: string): Promise<StoredProjectIndex> {
  try {
    const raw = await readFile(indexPath(userDataDir));
    if (raw.byteLength > INDEX_MAX_BYTES) return rebuildIndex(userDataDir);
    const parsed = normalizeIndex(JSON.parse(raw.toString("utf8")) as unknown);
    return parsed ?? rebuildIndex(userDataDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    return rebuildIndex(userDataDir);
  }
}

async function writeIndex(userDataDir: string, index: StoredProjectIndex): Promise<void> {
  if (!(await atomicWrite(indexPath(userDataDir), index, INDEX_MAX_BYTES))) throw new Error("project index exceeds safety cap");
}

async function fingerprint(path: string): Promise<ProjectSourceFingerprint | null> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    return { path, size: info.size, mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
}

async function sourceStatus(source: ProjectSourceFingerprint): Promise<ProjectSourceStatus> {
  const live = await fingerprint(source.path);
  if (!live) return "offline";
  return live.size === source.size && Math.abs(live.mtimeMs - source.mtimeMs) <= 1 ? "ready" : "changed";
}

function summary(entry: ProjectIndexEntry, status: ProjectSourceStatus): ProjectSummary {
  return {
    id: entry.id,
    name: entry.name,
    sourcePath: entry.source.path,
    sourceName: entry.sourceName,
    status,
    hasTranscript: entry.hasTranscript,
    candidateCount: entry.candidateCount,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    lastOpenedAt: entry.lastOpenedAt,
  };
}

async function statusForEntry(userDataDir: string, entry: ProjectIndexEntry): Promise<ProjectSourceStatus> {
  try {
    const documentInfo = await stat(projectPath(userDataDir, entry.id));
    if (!documentInfo.isFile()) return "corrupt";
  } catch {
    return "corrupt";
  }
  return sourceStatus(entry.source);
}

async function listFromIndex(userDataDir: string, index: StoredProjectIndex): Promise<ProjectSummary[]> {
  const projects = await Promise.all(index.projects.map(async (entry) => summary(entry, await statusForEntry(userDataDir, entry))));
  return projects.sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt) || b.updatedAt.localeCompare(a.updatedAt));
}

async function createProjectWithId(
  userDataDir: string,
  input: unknown,
  name: string | undefined,
  id: string,
): Promise<ProjectOpenResult | null> {
  const checkpoint = normalizeSessionCheckpoint(input);
  if (!checkpoint || !validProjectId(id)) return null;
  const source = await fingerprint(checkpoint.file.path);
  if (!source) return null;
  const index = await readIndex(userDataDir);
  if (index.projects.some((project) => project.id === id)) return openProject(userDataDir, id);
  if (index.projects.length >= PROJECT_WORKSPACE_MAX_PROJECTS) return null;
  const now = new Date().toISOString();
  const projectName = normalizeProjectName(name, sourceDisplayName(source.path));
  const document: StoredProjectDocument = {
    version: PROJECT_VERSION,
    id,
    name: projectName,
    source,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
    checkpoint,
  };
  if (!(await atomicWrite(projectPath(userDataDir, id), document, SESSION_CHECKPOINT_MAX_BYTES))) return null;
  const entry = indexEntryFromDocument(document);
  index.projects.push(entry);
  index.activeProjectId = id;
  await writeIndex(userDataDir, index);
  return { project: summary(entry, "ready"), checkpoint };
}

async function migrateLegacyCheckpoint(userDataDir: string): Promise<void> {
  const index = await readIndex(userDataDir);
  if (index.projects.some((project) => project.id === LEGACY_PROJECT_ID)) {
    await clearSessionCheckpoint(userDataDir);
    return;
  }
  const legacy = await readSessionCheckpoint(userDataDir);
  if (!legacy) return;
  try {
    const created = await createProjectWithId(userDataDir, legacy, undefined, LEGACY_PROJECT_ID);
    if (created) await clearSessionCheckpoint(userDataDir);
  } catch {
    // Preserve the legacy file so migration can retry on the next launch.
  }
}

export async function createProject(userDataDir: string, checkpoint: unknown, name?: string): Promise<ProjectOpenResult | null> {
  return createProjectWithId(userDataDir, checkpoint, name, randomUUID());
}

export async function openProject(userDataDir: string, id: string): Promise<ProjectOpenResult | null> {
  if (!validProjectId(id)) return null;
  const index = await readIndex(userDataDir);
  const entry = index.projects.find((project) => project.id === id);
  if (!entry) return null;
  const document = await readProjectDocument(userDataDir, id);
  if (!document) {
    entry.lastOpenedAt = new Date().toISOString();
    index.activeProjectId = id;
    await writeIndex(userDataDir, index);
    return { project: summary(entry, "corrupt"), checkpoint: null };
  }
  const status = await sourceStatus(document.source);
  const now = new Date().toISOString();
  entry.lastOpenedAt = now;
  document.lastOpenedAt = now;
  index.activeProjectId = id;
  await atomicWrite(projectPath(userDataDir, id), document, SESSION_CHECKPOINT_MAX_BYTES);
  await writeIndex(userDataDir, index);
  return { project: summary(entry, status), checkpoint: status === "ready" ? document.checkpoint : null };
}

export async function saveProject(userDataDir: string, id: string, input: unknown): Promise<boolean> {
  if (!validProjectId(id)) return false;
  const checkpoint = normalizeSessionCheckpoint(input);
  if (!checkpoint) return false;
  const index = await readIndex(userDataDir);
  const entry = index.projects.find((project) => project.id === id);
  const document = entry ? await readProjectDocument(userDataDir, id) : null;
  if (!entry || !document || checkpoint.file.path !== document.source.path) return false;
  if (await sourceStatus(document.source) !== "ready") return false;
  const now = new Date().toISOString();
  document.checkpoint = checkpoint;
  document.updatedAt = now;
  entry.updatedAt = now;
  entry.hasTranscript = checkpoint.transcript !== null;
  entry.candidateCount = checkpoint.candidates?.length ?? 0;
  if (!(await atomicWrite(projectPath(userDataDir, id), document, SESSION_CHECKPOINT_MAX_BYTES))) return false;
  await writeIndex(userDataDir, index);
  return true;
}

export async function renameProject(userDataDir: string, id: string, value: string): Promise<ProjectSummary | null> {
  if (!validProjectId(id)) return null;
  const index = await readIndex(userDataDir);
  const entry = index.projects.find((project) => project.id === id);
  const document = entry ? await readProjectDocument(userDataDir, id) : null;
  if (!entry || !document) return null;
  const now = new Date().toISOString();
  const name = normalizeProjectName(value, sourceDisplayName(document.source.path));
  entry.name = name;
  entry.updatedAt = now;
  document.name = name;
  document.updatedAt = now;
  if (!(await atomicWrite(projectPath(userDataDir, id), document, SESSION_CHECKPOINT_MAX_BYTES))) return null;
  await writeIndex(userDataDir, index);
  return summary(entry, await sourceStatus(entry.source));
}

export async function deleteProject(userDataDir: string, id: string): Promise<boolean> {
  if (!validProjectId(id)) return false;
  const index = await readIndex(userDataDir);
  const before = index.projects.length;
  index.projects = index.projects.filter((project) => project.id !== id);
  if (index.projects.length === before) return false;
  if (index.activeProjectId === id) index.activeProjectId = null;
  await writeIndex(userDataDir, index);
  await Promise.all([removeQuietly(projectPath(userDataDir, id)), removeQuietly(`${projectPath(userDataDir, id)}.tmp`)]);
  return true;
}

function relinkCompatible(previous: MediaInfo, next: MediaInfo): boolean {
  const durationTolerance = Math.max(2, previous.durationSec * 0.01);
  return Math.abs(previous.durationSec - next.durationSec) <= durationTolerance &&
    previous.hasVideo === next.hasVideo && previous.hasAudio === next.hasAudio;
}

export async function relinkProject(
  userDataDir: string,
  id: string,
  file: MediaInfo & { path: string },
): Promise<ProjectOpenResult | null> {
  if (!validProjectId(id)) return null;
  const index = await readIndex(userDataDir);
  const entry = index.projects.find((project) => project.id === id);
  const document = entry ? await readProjectDocument(userDataDir, id) : null;
  if (!entry || !document || !relinkCompatible(document.checkpoint.file, file)) return null;
  const source = await fingerprint(file.path);
  if (!source) return null;
  const checkpoint = normalizeSessionCheckpoint({ ...document.checkpoint, file, savedAt: new Date().toISOString() });
  if (!checkpoint) return null;
  const now = new Date().toISOString();
  document.source = source;
  document.checkpoint = checkpoint;
  document.updatedAt = now;
  document.lastOpenedAt = now;
  entry.source = source;
  entry.sourceName = basename(source.path);
  entry.updatedAt = now;
  entry.lastOpenedAt = now;
  index.activeProjectId = id;
  if (!(await atomicWrite(projectPath(userDataDir, id), document, SESSION_CHECKPOINT_MAX_BYTES))) return null;
  await writeIndex(userDataDir, index);
  return { project: summary(entry, "ready"), checkpoint };
}

export async function closeProject(userDataDir: string): Promise<void> {
  const index = await readIndex(userDataDir);
  if (index.activeProjectId === null) return;
  index.activeProjectId = null;
  await writeIndex(userDataDir, index);
}

export async function projectWorkspace(userDataDir: string): Promise<ProjectWorkspaceBootstrap> {
  await migrateLegacyCheckpoint(userDataDir);
  let index = await readIndex(userDataDir);
  let active: ProjectOpenResult | null = null;
  if (index.activeProjectId) active = await openProject(userDataDir, index.activeProjectId);
  index = await readIndex(userDataDir);
  const projects = await listFromIndex(userDataDir, index);
  if (active) {
    const position = projects.findIndex((project) => project.id === active.project.id);
    if (position >= 0) projects[position] = active.project;
  }
  return {
    projects,
    activeProjectId: active?.project.id ?? index.activeProjectId,
    active,
  };
}
