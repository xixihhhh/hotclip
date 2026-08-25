import { mkdtemp, stat, unlink, utimes, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { describe, expect, it } from "vitest";
import type { SessionCheckpoint } from "../../shared/api-types";
import { clearSessionCheckpoint, normalizeSessionCheckpoint, readSessionCheckpoint, saveSessionCheckpoint, SESSION_CHECKPOINT_MAX_BYTES } from "../session-checkpoint";
import { SESSION_EDIT_HISTORY_MAX_BYTES, SESSION_EDIT_HISTORY_MAX_COMMANDS } from "../../shared/session-edit-history";

async function fixture(): Promise<{ dir: string; source: string; checkpoint: SessionCheckpoint }> {
  const dir = await mkdtemp(join(tmpdir(), "hotclip-session-"));
  const source = join(dir, "source.mp4");
  await writeFile(source, "video");
  return {
    dir,
    source,
    checkpoint: {
      file: { path: source, durationSec: 12, hasVideo: true, hasAudio: true, width: 1920, height: 1080, fps: 30, bitRate: 1, videoCodec: "h264", audioCodec: "aac" },
      transcript: null,
      candidates: [{ id: 7, startSec: 1, endSec: 4, text: "text", title: "title", hook: "hook", score: 80, reason: "reason", boundary: "exact", keywords: [], recommended: true, reviewNote: "" }],
      selected: [7, 7, 99], focusedId: 99,
      stats: { funnel: null, vision: null, emotion: null, danmaku: null, voice: null, reference: null, referenceError: null },
      diarize: false, referencePath: null, paramsDirty: false, savedAt: new Date().toISOString(),
    },
  };
}

describe("session checkpoint", () => {
  it("roundtrips and normalizes candidate references", async () => {
    const { dir, checkpoint } = await fixture();
    expect(await saveSessionCheckpoint(dir, checkpoint)).toBe(true);
    expect(await readSessionCheckpoint(dir)).toMatchObject({ selected: [7], focusedId: null });
  });

  it("invalidates a changed source", async () => {
    const { dir, source, checkpoint } = await fixture();
    await saveSessionCheckpoint(dir, checkpoint);
    await writeFile(source, "changed video");
    expect(await readSessionCheckpoint(dir)).toBeNull();
  });

  it("invalidates an mtime-only source change", async () => {
    const { dir, source, checkpoint } = await fixture();
    await saveSessionCheckpoint(dir, checkpoint);
    const future = new Date(Date.now() + 10_000);
    await utimes(source, future, future);
    expect(await readSessionCheckpoint(dir)).toBeNull();
  });

  it("invalidates a missing source", async () => {
    const { dir, source, checkpoint } = await fixture();
    await saveSessionCheckpoint(dir, checkpoint);
    await unlink(source);
    expect(await readSessionCheckpoint(dir)).toBeNull();
  });

  it("discards corrupt JSON", async () => {
    const { dir } = await fixture();
    await writeFile(join(dir, "active-session.json"), "{bad");
    expect(await readSessionCheckpoint(dir)).toBeNull();
  });

  it("clears the checkpoint and leftover temp file", async () => {
    const { dir, checkpoint } = await fixture();
    await saveSessionCheckpoint(dir, checkpoint);
    await writeFile(join(dir, "active-session.json.tmp"), "partial");
    await clearSessionCheckpoint(dir);
    await expect(stat(join(dir, "active-session.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(dir, "active-session.json.tmp"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects malformed and oversized checkpoints", async () => {
    const { dir, checkpoint } = await fixture();
    expect(await saveSessionCheckpoint(dir, {})).toBe(false);
    checkpoint.candidates![0].text = "x".repeat(SESSION_CHECKPOINT_MAX_BYTES);
    expect(await saveSessionCheckpoint(dir, checkpoint)).toBe(false);
  });

  it("preserves valid edit history and drops malformed or oversized history without losing the session", async () => {
    const { checkpoint } = await fixture();
    const command = { kind: "selection" as const, before: [7], after: [] };
    const bounded = normalizeSessionCheckpoint({
      ...checkpoint,
      editHistory: { undo: Array.from({ length: SESSION_EDIT_HISTORY_MAX_COMMANDS + 5 }, () => command), redo: [] },
    });
    expect(bounded?.editHistory?.undo).toHaveLength(SESSION_EDIT_HISTORY_MAX_COMMANDS);

    const malformed = normalizeSessionCheckpoint({ ...checkpoint, editHistory: { undo: [{ kind: "selection", before: "bad", after: [] }], redo: [] } });
    expect(malformed).not.toBeNull();
    expect(malformed).not.toHaveProperty("editHistory");

    const hugeCandidate = { ...checkpoint.candidates![0], title: "x".repeat(SESSION_EDIT_HISTORY_MAX_BYTES) };
    const oversized = normalizeSessionCheckpoint({
      ...checkpoint,
      editHistory: { undo: [{ kind: "candidate-update", candidateId: 7, before: checkpoint.candidates![0], after: hugeCandidate }], redo: [] },
    });
    expect(oversized).not.toBeNull();
    expect(oversized).not.toHaveProperty("editHistory");
  });
});
