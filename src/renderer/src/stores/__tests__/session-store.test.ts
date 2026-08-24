import { beforeEach, describe, expect, it } from "vitest";
import type { SessionCheckpoint } from "../../../../shared/api-types";
import { sessionCheckpointFromState, useSession } from "../session-store";

const checkpoint: SessionCheckpoint = {
  file: { path: "/video.mp4", durationSec: 12, hasVideo: true, hasAudio: true, width: 1920, height: 1080, fps: 30, bitRate: 1, videoCodec: "h264", audioCodec: "aac" },
  transcript: null,
  candidates: [{ id: 3, startSec: 1, endSec: 4, text: "text", title: "edited", hook: "hook", score: 80, reason: "reason", boundary: "exact", keywords: [], recommended: true, reviewNote: "", manualBounds: true }],
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
});
