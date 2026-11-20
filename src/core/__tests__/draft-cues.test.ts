import { expect, it } from "vitest";
import { buildCaptionAss, VERTICAL_LAYOUT } from "../subtitle";
import { draftCuesFromAss, shiftDraftCues, trimDraftSegments } from "../draft-cues";

it("preserves rendered text, plate colour and relative placement while removing ASS control codes", () => {
  const ass = buildCaptionAss([{ text: "first", startSec: 5, endSec: 6 }], 5, VERTICAL_LAYOUT, "minimal", {
    titleCard: { text: "Round, one", style: "brandPlate", durationSec: 2 }, highlightHex: "#FFDD00",
  });
  const cues = draftCuesFromAss(ass);
  const title = cues.find((cue) => cue.role === "Title")!;
  expect(title).toMatchObject({ text: "Round, one", startSec: 0, endSec: 2,
    look: { color: "#000000", border: { color: "#FFDD00", box: true } } });
  expect(title.look!.y).toBeGreaterThan(0);
  const caption = cues.find((cue) => cue.role === "Caption")!;
  expect(caption.text).toBe("first");
  expect(caption.look!.y).toBeLessThan(0);
});

it("keeps repeated intro footage, later source segments and edited captions aligned after QA trims", () => {
  const edl = trimDraftSegments([{ startSec: 20, endSec: 22 }, { startSec: 5, endSec: 8 }, { startSec: 20, endSec: 24 }], .5, 7);
  expect(edl).toEqual([{ startSec: 20.5, endSec: 22 }, { startSec: 5, endSec: 8 }, { startSec: 20, endSec: 22.5 }]);
  const shifted = shiftDraftCues([{ role: "Caption", startSec: 1, endSec: 3, text: "body" }], 1.5, 4);
  expect(shifted[0]).toMatchObject({ startSec: 2.5, endSec: 4 });
});
