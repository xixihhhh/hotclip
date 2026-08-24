import { mkdir, readFile, rename, unlink, writeFile } from "fs/promises";
import { join } from "path";
import type { AutomationTask } from "../shared/api-types";

const FILE_NAME = "automation-tasks.json";
const VERSION = 1;
export const AUTOMATION_HISTORY_LIMIT = 200;
const MAX_BYTES = 2 * 1024 * 1024;

const STATUSES = new Set(["queued", "running", "completed", "failed", "cancelled", "interrupted"]);
const STAGES = new Set(["queued", "transcribing", "detecting", "exporting"]);
const TRIGGERS = new Set(["folder", "webhook", "retry"]);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function validTask(value: unknown): value is AutomationTask {
  return isObject(value) && typeof value.id === "string" && value.id.length > 0 &&
    typeof value.sourcePath === "string" && typeof value.sourceName === "string" &&
    finite(value.sourceSize) && finite(value.sourceMtimeMs) && TRIGGERS.has(String(value.trigger)) &&
    STATUSES.has(String(value.status)) && STAGES.has(String(value.stage)) && finite(value.attempts) &&
    typeof value.createdAt === "string" && typeof value.updatedAt === "string" &&
    (value.clips === undefined || finite(value.clips)) && (value.outDir === undefined || typeof value.outDir === "string") &&
    (value.error === undefined || typeof value.error === "string");
}

export function normalizeAutomationTasks(value: unknown, recoverActive = false): AutomationTask[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value
    .filter(validTask)
    .filter((task) => {
      if (seen.has(task.id)) return false;
      seen.add(task.id);
      return true;
    })
    .map((task) => recoverActive && (task.status === "queued" || task.status === "running")
      ? { ...task, status: "interrupted" as const, error: undefined, updatedAt: new Date().toISOString() }
      : task)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, AUTOMATION_HISTORY_LIMIT);
}

function historyPath(userDataDir: string): string {
  return join(userDataDir, FILE_NAME);
}

export async function loadAutomationTasks(userDataDir: string, recoverActive = false): Promise<AutomationTask[]> {
  try {
    const raw = await readFile(historyPath(userDataDir));
    if (raw.byteLength > MAX_BYTES) return [];
    const parsed = JSON.parse(raw.toString("utf8")) as unknown;
    if (!isObject(parsed) || parsed.version !== VERSION) return [];
    return normalizeAutomationTasks(parsed.tasks, recoverActive);
  } catch {
    return [];
  }
}

export async function saveAutomationTasks(userDataDir: string, tasks: AutomationTask[]): Promise<void> {
  const normalized = normalizeAutomationTasks(tasks);
  const payload = JSON.stringify({ version: VERSION, tasks: normalized });
  if (Buffer.byteLength(payload) > MAX_BYTES) throw new Error("automation task history is too large");
  await mkdir(userDataDir, { recursive: true });
  const path = historyPath(userDataDir);
  const temp = `${path}.tmp`;
  await writeFile(temp, payload, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
}

export async function clearAutomationTasks(userDataDir: string): Promise<void> {
  for (const path of [historyPath(userDataDir), `${historyPath(userDataDir)}.tmp`]) {
    try { await unlink(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
