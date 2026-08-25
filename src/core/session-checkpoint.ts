import { mkdir, readFile, rename, stat, unlink, writeFile } from "fs/promises";
import { join } from "path";
import type { HighlightCandidate, SessionCheckpoint, SessionEditCommand, SessionEditHistory, Transcript, TranscriptSegment } from "../shared/api-types";
import { compactSessionEditHistory } from "../shared/session-edit-history";

const VERSION = 1;
const FILE_NAME = "active-session.json";
export const SESSION_CHECKPOINT_MAX_BYTES = 32 * 1024 * 1024;

interface StoredCheckpoint {
  version: typeof VERSION;
  source: { size: number; mtimeMs: number };
  checkpoint: SessionCheckpoint;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function validTranscriptSegment(segment: unknown): segment is TranscriptSegment {
  if (!isObject(segment) || !finite(segment.id) || !finite(segment.startSec) || !finite(segment.endSec) || typeof segment.text !== "string" || !Array.isArray(segment.words)) return false;
  return segment.words.every((word) => isObject(word) && typeof word.text === "string" && finite(word.startSec) && finite(word.endSec));
}

function validTranscript(value: unknown): value is Transcript {
  return isObject(value) && typeof value.language === "string" && typeof value.engine === "string" && finite(value.durationSec) &&
    Array.isArray(value.segments) && value.segments.every(validTranscriptSegment);
}

function validCandidate(value: unknown): value is HighlightCandidate {
  return isObject(value) && finite(value.id) && finite(value.startSec) && finite(value.endSec) &&
    typeof value.text === "string" && typeof value.title === "string" && typeof value.hook === "string" &&
    finite(value.score) && typeof value.reason === "string" &&
    ["exact", "anchored", "segment", "signal"].includes(String(value.boundary)) &&
    Array.isArray(value.keywords) && value.keywords.every((word) => typeof word === "string") &&
    typeof value.recommended === "boolean" && typeof value.reviewNote === "string";
}

function nullableObject(value: unknown): boolean {
  return value === null || isObject(value);
}

function validIdList(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(finite);
}

function validEditCommand(value: unknown): value is SessionEditCommand {
  if (!isObject(value) || typeof value.kind !== "string") return false;
  if (value.kind === "selection") return validIdList(value.before) && validIdList(value.after);
  if (value.kind === "candidate-update") {
    return finite(value.candidateId) && validCandidate(value.before) && validCandidate(value.after) &&
      value.before.id === value.candidateId && value.after.id === value.candidateId;
  }
  if (value.kind === "candidate-add") {
    return validCandidate(value.candidate) && validIdList(value.beforeSelected) && validIdList(value.afterSelected) &&
      (value.beforeFocusedId === null || finite(value.beforeFocusedId)) && (value.afterFocusedId === null || finite(value.afterFocusedId));
  }
  if (value.kind === "transcript-update") {
    if (!Array.isArray(value.changes) || value.changes.length === 0) return false;
    const ids = new Set<number>();
    return value.changes.every((change) => {
      if (!isObject(change) || !finite(change.segmentId) || !validTranscriptSegment(change.before) || !validTranscriptSegment(change.after) ||
          change.before.id !== change.segmentId || change.after.id !== change.segmentId || ids.has(change.segmentId)) return false;
      ids.add(change.segmentId);
      return true;
    });
  }
  return false;
}

function normalizeEditHistory(value: unknown): SessionEditHistory | undefined {
  if (!isObject(value) || !Array.isArray(value.undo) || !Array.isArray(value.redo) ||
      !value.undo.every(validEditCommand) || !value.redo.every(validEditCommand)) return undefined;
  const compacted = compactSessionEditHistory({ undo: value.undo, redo: value.redo });
  return compacted.undo.length + compacted.redo.length > 0 ? compacted : undefined;
}

/** Reject malformed disk data and normalize selection/focus against live candidates. */
export function normalizeSessionCheckpoint(value: unknown): SessionCheckpoint | null {
  if (!isObject(value) || !isObject(value.file) || typeof value.file.path !== "string" || value.file.path.length === 0) return null;
  const file = value.file;
  if (!finite(file.durationSec) || typeof file.hasVideo !== "boolean" || typeof file.hasAudio !== "boolean" ||
      !finite(file.width) || !finite(file.height) || !finite(file.fps) || !finite(file.bitRate) ||
      typeof file.videoCodec !== "string" || typeof file.audioCodec !== "string") return null;
  if (value.transcript !== null && !validTranscript(value.transcript)) return null;
  if (value.candidates !== null && (!Array.isArray(value.candidates) || !value.candidates.every(validCandidate))) return null;
  if (!Array.isArray(value.selected) || !value.selected.every(finite) || !isObject(value.stats) ||
      !nullableObject(value.stats.funnel) || !nullableObject(value.stats.vision) || !nullableObject(value.stats.emotion) ||
      !nullableObject(value.stats.danmaku) || !nullableObject(value.stats.voice) || !nullableObject(value.stats.reference) ||
      (value.stats.referenceError !== null && typeof value.stats.referenceError !== "string") ||
      typeof value.diarize !== "boolean" || (value.referencePath !== null && typeof value.referencePath !== "string") ||
      typeof value.paramsDirty !== "boolean" || typeof value.savedAt !== "string") return null;

  const candidates = value.candidates as HighlightCandidate[] | null;
  const ids = new Set((candidates ?? []).map((candidate) => candidate.id));
  const selected = [...new Set(value.selected as number[])].filter((id) => ids.has(id));
  const focusedId = finite(value.focusedId) && ids.has(value.focusedId) ? value.focusedId : null;
  const normalized = { ...(value as unknown as SessionCheckpoint), selected, focusedId };
  const editHistory = normalizeEditHistory(value.editHistory);
  if (editHistory) normalized.editHistory = editHistory;
  else delete normalized.editHistory;
  return normalized;
}

function checkpointPath(userDataDir: string): string {
  return join(userDataDir, FILE_NAME);
}

async function removeQuietly(path: string): Promise<void> {
  try { await unlink(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function saveSessionCheckpoint(userDataDir: string, input: unknown): Promise<boolean> {
  const checkpoint = normalizeSessionCheckpoint(input);
  if (!checkpoint) return false;
  let source: { size: number; mtimeMs: number };
  try {
    const info = await stat(checkpoint.file.path);
    if (!info.isFile()) return false;
    source = { size: info.size, mtimeMs: info.mtimeMs };
  } catch {
    return false;
  }
  const payload = JSON.stringify({ version: VERSION, source, checkpoint } satisfies StoredCheckpoint);
  if (Buffer.byteLength(payload) > SESSION_CHECKPOINT_MAX_BYTES) return false;
  await mkdir(userDataDir, { recursive: true });
  const path = checkpointPath(userDataDir);
  const temp = `${path}.tmp`;
  await writeFile(temp, payload, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
  return true;
}

export async function readSessionCheckpoint(userDataDir: string): Promise<SessionCheckpoint | null> {
  const path = checkpointPath(userDataDir);
  try {
    const raw = await readFile(path);
    if (raw.byteLength > SESSION_CHECKPOINT_MAX_BYTES) {
      await removeQuietly(path);
      return null;
    }
    const stored = JSON.parse(raw.toString("utf8")) as unknown;
    if (!isObject(stored) || stored.version !== VERSION || !isObject(stored.source) || !finite(stored.source.size) || !finite(stored.source.mtimeMs)) throw new Error("invalid checkpoint envelope");
    const checkpoint = normalizeSessionCheckpoint(stored.checkpoint);
    if (!checkpoint) throw new Error("invalid checkpoint body");
    const info = await stat(checkpoint.file.path);
    if (!info.isFile() || info.size !== stored.source.size || Math.abs(info.mtimeMs - stored.source.mtimeMs) > 1) {
      await removeQuietly(path);
      return null;
    }
    return checkpoint;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") await removeQuietly(path);
    return null;
  }
}

export async function clearSessionCheckpoint(userDataDir: string): Promise<void> {
  await Promise.all([removeQuietly(checkpointPath(userDataDir)), removeQuietly(`${checkpointPath(userDataDir)}.tmp`)]);
}
