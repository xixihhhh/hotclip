import { mkdtemp } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { describe, expect, it } from "vitest";
import type { AutomationTask } from "../../shared/api-types";
import { clearAutomationTasks, loadAutomationTasks, normalizeAutomationTasks, saveAutomationTasks } from "../automation-history";

const task = (id: string, status: AutomationTask["status"] = "completed"): AutomationTask => ({
  id, sourcePath: `/videos/${id}.mp4`, sourceName: `${id}.mp4`, sourceSize: 10, sourceMtimeMs: 20,
  trigger: "folder", status, stage: status === "completed" ? "exporting" : "queued", attempts: 1,
  createdAt: "2026-08-24T00:00:00.000Z", updatedAt: `2026-08-24T00:00:0${id}.000Z`,
});

describe("automation history", () => {
  it("roundtrips newest first and removes duplicate ids", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hotclip-tasks-"));
    await saveAutomationTasks(dir, [task("1"), task("2"), task("1")]);
    expect((await loadAutomationTasks(dir)).map((item) => item.id)).toEqual(["2", "1"]);
  });

  it("marks active tasks interrupted after restart", () => {
    const recovered = normalizeAutomationTasks([task("1", "queued"), task("2", "running"), task("3")], true);
    expect(recovered.map((item) => item.status).sort()).toEqual(["completed", "interrupted", "interrupted"]);
    expect(recovered.filter((item) => item.status === "interrupted").every((item) => item.error === undefined)).toBe(true);
  });

  it("drops malformed records and clears persisted history", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hotclip-tasks-"));
    expect(normalizeAutomationTasks([{}, task("1")])).toHaveLength(1);
    await saveAutomationTasks(dir, [task("1")]);
    await clearAutomationTasks(dir);
    expect(await loadAutomationTasks(dir)).toEqual([]);
  });

  it("bounds history to the newest 200 records", () => {
    const many = Array.from({ length: 240 }, (_, index) => ({
      ...task(String(index).padStart(3, "0")),
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    }));
    const normalized = normalizeAutomationTasks(many);
    expect(normalized).toHaveLength(200);
    expect(normalized[0].id).toBe("239");
    expect(normalized.at(-1)?.id).toBe("040");
  });
});
