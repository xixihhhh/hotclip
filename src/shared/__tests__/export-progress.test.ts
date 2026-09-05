import { describe, expect, it } from "vitest";
import { exportProgressPercent } from "../export-progress";
import { exportNeedsTranscript } from "../export-transcript";

describe("truthful export progress", () => {
  it("does not invent encoding progress during preparation or report completion before delivery", () => {
    const event = { current: 1, total: 2, clipId: 1 };
    expect(exportProgressPercent(null)).toBe(0);
    expect(exportProgressPercent({ ...event, current: 0, stage: "preparing" })).toBe(0);
    expect(exportProgressPercent({ ...event, stage: "cutting" })).toBe(0);
    expect(exportProgressPercent({ ...event, stage: "cutting", fraction: 0.5 })).toBe(25);
    expect(exportProgressPercent({ ...event, stage: "done" })).toBe(50);
    expect(exportProgressPercent({ ...event, current: 2, stage: "finalizing" })).toBe(99);
    expect(exportProgressPercent({ ...event, total: 0, stage: "done" })).toBe(0);
  });

  it("retains word timing for sidecar-only captions and speech muting", () => {
    expect(exportNeedsTranscript({ captionStyle: "none", subtitleFile: true })).toBe(true);
    expect(exportNeedsTranscript({ captionStyle: "none", muteTerms: ["private"] })).toBe(true);
    expect(exportNeedsTranscript({ captionStyle: "none", subtitleFile: false })).toBe(false);
  });
});
