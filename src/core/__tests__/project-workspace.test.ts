import { mkdtemp, readFile, stat, unlink, utimes, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { describe, expect, it } from "vitest";
import type { MediaInfo, SessionCheckpoint } from "../../shared/api-types";
import { saveSessionCheckpoint } from "../session-checkpoint";
import {
  closeProject,
  createProject,
  deleteProject,
  openProject,
  projectWorkspace,
  relinkProject,
  renameProject,
  saveProject,
} from "../project-workspace";

async function fixture(): Promise<{ dir: string; source: string; checkpoint: SessionCheckpoint }> {
  const dir = await mkdtemp(join(tmpdir(), "hotclip-projects-"));
  const source = join(dir, "source.mp4");
  await writeFile(source, "video-one");
  return {
    dir,
    source,
    checkpoint: {
      file: { path: source, durationSec: 120, hasVideo: true, hasAudio: true, width: 1920, height: 1080, fps: 30, bitRate: 1, videoCodec: "h264", audioCodec: "aac" },
      transcript: null,
      candidates: [{ id: 7, startSec: 1, endSec: 4, text: "text", title: "title", hook: "hook", score: 80, reason: "reason", boundary: "exact", keywords: [], recommended: true, reviewNote: "" }],
      selected: [7], focusedId: 7,
      stats: { funnel: null, vision: null, emotion: null, danmaku: null, voice: null, reference: null, referenceError: null },
      diarize: false, referencePath: null, paramsDirty: false, savedAt: new Date().toISOString(),
    },
  };
}

function media(path: string, durationSec = 120): MediaInfo & { path: string } {
  return { path, durationSec, hasVideo: true, hasAudio: true, width: 1920, height: 1080, fps: 30, bitRate: 1, videoCodec: "h264", audioCodec: "aac" };
}

describe("project workspace", () => {
  it("creates, lists, opens, saves, renames, and closes projects", async () => {
    const { dir, checkpoint } = await fixture();
    const created = await createProject(dir, checkpoint, "  Launch   edit  ");
    expect(created?.project).toMatchObject({ name: "Launch edit", status: "ready", candidateCount: 1 });

    checkpoint.candidates![0].title = "manual title";
    expect(await saveProject(dir, created!.project.id, checkpoint)).toBe(true);
    expect((await openProject(dir, created!.project.id))?.checkpoint?.candidates?.[0].title).toBe("manual title");

    const renamed = await renameProject(dir, created!.project.id, "\u0000 Final   cut ");
    expect(renamed?.name).toBe("Final cut");
    expect((await projectWorkspace(dir)).projects).toMatchObject([{ id: created!.project.id, name: "Final cut", status: "ready" }]);

    await closeProject(dir);
    expect((await projectWorkspace(dir)).activeProjectId).toBeNull();
  });

  it("keeps offline and changed projects instead of deleting them", async () => {
    const { dir, source, checkpoint } = await fixture();
    const created = await createProject(dir, checkpoint);
    await unlink(source);
    let workspace = await projectWorkspace(dir);
    expect(workspace.projects[0].status).toBe("offline");
    expect((await openProject(dir, created!.project.id))?.checkpoint).toBeNull();

    await writeFile(source, "video-one");
    const future = new Date(Date.now() + 20_000);
    await utimes(source, future, future);
    workspace = await projectWorkspace(dir);
    expect(workspace.projects[0].status).toBe("changed");
  });

  it("relinks only compatible media and preserves the editing state", async () => {
    const { dir, source, checkpoint } = await fixture();
    const created = await createProject(dir, checkpoint);
    await unlink(source);
    const replacement = join(dir, "moved-source.mp4");
    await writeFile(replacement, "video-one");

    expect(await relinkProject(dir, created!.project.id, media(replacement, 600))).toBeNull();
    const relinked = await relinkProject(dir, created!.project.id, media(replacement));
    expect(relinked?.project).toMatchObject({ sourcePath: replacement, status: "ready" });
    expect(relinked?.checkpoint?.candidates?.[0].id).toBe(7);
    expect(relinked?.checkpoint?.file.path).toBe(replacement);
  });

  it("deletes only the project document, never the source media", async () => {
    const { dir, source, checkpoint } = await fixture();
    const created = await createProject(dir, checkpoint);
    expect(await deleteProject(dir, created!.project.id)).toBe(true);
    expect((await stat(source)).isFile()).toBe(true);
    expect((await projectWorkspace(dir)).projects).toHaveLength(0);
  });

  it("migrates the legacy active session once and clears it only after success", async () => {
    const { dir, checkpoint } = await fixture();
    expect(await saveSessionCheckpoint(dir, checkpoint)).toBe(true);
    const first = await projectWorkspace(dir);
    expect(first.projects).toHaveLength(1);
    expect(first.active?.checkpoint?.file.path).toBe(checkpoint.file.path);
    await expect(stat(join(dir, "active-session.json"))).rejects.toMatchObject({ code: "ENOENT" });

    const second = await projectWorkspace(dir);
    expect(second.projects).toHaveLength(1);
  });

  it("surfaces a corrupt project without destroying the library entry", async () => {
    const { dir, checkpoint } = await fixture();
    const created = await createProject(dir, checkpoint);
    await writeFile(join(dir, "projects", `${created!.project.id}.hotclip`), "{bad");
    const opened = await openProject(dir, created!.project.id);
    expect(opened).toMatchObject({ project: { status: "corrupt" }, checkpoint: null });
    expect((await projectWorkspace(dir)).projects).toMatchObject([{ id: created!.project.id, status: "corrupt" }]);
  });

  it("rebuilds a corrupt index from valid project documents", async () => {
    const { dir, checkpoint } = await fixture();
    const created = await createProject(dir, checkpoint, "Recovered");
    await writeFile(join(dir, "projects", "index.json"), "not json");
    const workspace = await projectWorkspace(dir);
    expect(workspace.projects).toMatchObject([{ id: created!.project.id, name: "Recovered" }]);
    const index = JSON.parse(await readFile(join(dir, "projects", "index.json"), "utf8")) as { version: number };
    expect(index.version).toBe(1);
  });
});
