import { beforeEach, describe, expect, it } from "vitest";
import type { HighlightCandidate, SessionCheckpoint, Transcript } from "../../../../shared/api-types";
import { sessionCheckpointFromState, useSession } from "../session-store";

const candidate = checkpointCandidate();

function checkpointCandidate(): HighlightCandidate {
  return { id: 3, startSec: 1, endSec: 4, text: "text", title: "edited", hook: "hook", score: 80, reason: "reason", boundary: "exact", keywords: [], recommended: true, reviewNote: "", manualBounds: true };
}

function transcript(): Transcript {
  return {
    language: "zh",
    engine: "test",
    durationSec: 12,
    segments: [
      { id: 1, startSec: 0, endSec: 2, text: "第一句", words: [{ text: "第一句", startSec: 0, endSec: 2 }] },
      { id: 2, startSec: 2, endSec: 4, text: "第二句", words: [{ text: "第二句", startSec: 2, endSec: 4 }] },
    ],
  };
}

const checkpoint: SessionCheckpoint = {
  file: { path: "/video.mp4", durationSec: 12, hasVideo: true, hasAudio: true, width: 1920, height: 1080, fps: 30, bitRate: 1, videoCodec: "h264", audioCodec: "aac" },
  transcript: null,
  candidates: [candidate],
  selected: [3, 100], focusedId: 100,
  stats: { funnel: null, vision: null, emotion: null, danmaku: null, voice: null, reference: null, referenceError: null },
  diarize: true, referencePath: "/reference.mp4", paramsDirty: true, savedAt: "2026-08-24T00:00:00.000Z",
};

describe("session store recovery", () => {
  beforeEach(() => useSession.getState().reset());

  it("restores stable edits and resets transient state", () => {
    useSession.setState({ auto: true, settingsOpen: true, detecting: true, detectError: "old", exporting: { clips: [], options: {} as never } });
    useSession.getState().restore(checkpoint);
    const state = useSession.getState();
    expect(state.file?.path).toBe("/video.mp4");
    expect(state.candidates?.[0]).toMatchObject({ title: "edited", manualBounds: true });
    expect([...state.selected]).toEqual([3]);
    expect(state.focusedId).toBeNull();
    expect(state).toMatchObject({ auto: false, settingsOpen: false, detecting: false, detectError: null, exporting: null });
  });

  it("serializes only the stable checkpoint contract", () => {
    useSession.getState().restore({ ...checkpoint, selected: [3], focusedId: 3 });
    const saved = sessionCheckpointFromState();
    expect(saved).toMatchObject({ selected: [3], focusedId: 3, diarize: true, paramsDirty: true });
    expect(saved).not.toHaveProperty("detecting");
    expect(saved).not.toHaveProperty("exporting");
    expect(saved?.savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("undoes and redoes selection and candidate edits", () => {
    useSession.getState().restore({ ...checkpoint, selected: [3], focusedId: 3 });
    useSession.getState().toggleSelected(3);
    useSession.getState().patchCandidate(3, { title: "new title", startSec: 1.5 });
    expect(useSession.getState().candidates?.[0]).toMatchObject({ title: "new title", startSec: 1.5 });
    expect([...useSession.getState().selected]).toEqual([]);

    useSession.getState().undoEdit();
    expect(useSession.getState().candidates?.[0]).toMatchObject({ title: "edited", startSec: 1 });
    useSession.getState().undoEdit();
    expect([...useSession.getState().selected]).toEqual([3]);
    useSession.getState().redoEdit();
    useSession.getState().redoEdit();
    expect(useSession.getState().candidates?.[0]).toMatchObject({ title: "new title", startSec: 1.5 });
    expect([...useSession.getState().selected]).toEqual([]);
  });

  it("treats a manually added clip as one atomic command", () => {
    useSession.getState().restore({ ...checkpoint, selected: [3], focusedId: 3 });
    const added = { ...checkpointCandidate(), id: 4, startSec: 5, endSec: 8, title: "manual" };
    useSession.getState().addCandidate(added);
    expect(useSession.getState()).toMatchObject({ focusedId: 4 });
    expect(useSession.getState().candidates?.map((item) => item.id)).toEqual([3, 4]);
    expect([...useSession.getState().selected]).toEqual([3, 4]);

    useSession.getState().undoEdit();
    expect(useSession.getState().candidates?.map((item) => item.id)).toEqual([3]);
    expect([...useSession.getState().selected]).toEqual([3]);
    expect(useSession.getState().focusedId).toBe(3);
    useSession.getState().redoEdit();
    expect(useSession.getState().candidates?.map((item) => item.id)).toEqual([3, 4]);
    expect(useSession.getState().focusedId).toBe(4);
  });

  it("stores only changed transcript segments and restores them", () => {
    const original = transcript();
    useSession.getState().restore({ ...checkpoint, transcript: original });
    const edited = { ...original, segments: [original.segments[0], { ...original.segments[1], text: "修正后" }] };
    useSession.getState().editTranscript(edited);
    expect(useSession.getState().editHistory.undo[0]).toMatchObject({ kind: "transcript-update", changes: [{ segmentId: 2 }] });
    expect(useSession.getState().transcript?.segments[1].text).toBe("修正后");
    useSession.getState().undoEdit();
    expect(useSession.getState().transcript?.segments[1].text).toBe("第二句");
    useSession.getState().redoEdit();
    expect(useSession.getState().transcript?.segments[1].text).toBe("修正后");
  });

  it("persists history, clears redo after a branch, and resets it on a new AI baseline", () => {
    useSession.getState().restore({ ...checkpoint, selected: [3] });
    useSession.getState().patchCandidate(3, { title: "first" });
    useSession.getState().undoEdit();
    expect(useSession.getState().editHistory.redo).toHaveLength(1);
    useSession.getState().toggleSelected(3);
    expect(useSession.getState().editHistory.redo).toHaveLength(0);
    expect(sessionCheckpointFromState()?.editHistory?.undo).toHaveLength(1);
    useSession.getState().setCandidates([checkpointCandidate()]);
    expect(useSession.getState().editHistory).toEqual({ undo: [], redo: [] });
  });

  it("can undo an edit after checkpoint restoration", () => {
    useSession.getState().restore({ ...checkpoint, selected: [3] });
    useSession.getState().patchCandidate(3, { title: "persisted edit" });
    const saved = sessionCheckpointFromState();
    expect(saved?.editHistory?.undo).toHaveLength(1);
    useSession.getState().reset();
    useSession.getState().restore(saved!);
    useSession.getState().undoEdit();
    expect(useSession.getState().candidates?.[0].title).toBe("edited");
  });

  it("caps retained commands at the bounded history limit", () => {
    useSession.getState().restore({ ...checkpoint, selected: [3] });
    for (let i = 0; i < 75; i += 1) useSession.getState().toggleSelected(3);
    expect(useSession.getState().editHistory.undo).toHaveLength(60);
  });
});
