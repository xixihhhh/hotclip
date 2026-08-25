import { describe, expect, it } from "vitest";
import { resolveWorkbenchShortcut } from "../keyboard-shortcuts";

describe("workbench keyboard shortcuts", () => {
  it("maps history shortcuts on macOS and Windows", () => {
    expect(resolveWorkbenchShortcut({ key: "z", metaKey: true })).toBe("undo");
    expect(resolveWorkbenchShortcut({ key: "Z", ctrlKey: true, shiftKey: true })).toBe("redo");
    expect(resolveWorkbenchShortcut({ key: "y", ctrlKey: true })).toBe("redo");
  });

  it("maps transport, marks, and candidate navigation", () => {
    expect(resolveWorkbenchShortcut({ key: " ", code: "Space" })).toBe("toggle-play");
    expect(resolveWorkbenchShortcut({ key: "k" })).toBe("toggle-play");
    expect(resolveWorkbenchShortcut({ key: "j" })).toBe("back-5");
    expect(resolveWorkbenchShortcut({ key: "l" })).toBe("forward-5");
    expect(resolveWorkbenchShortcut({ key: "i" })).toBe("set-in");
    expect(resolveWorkbenchShortcut({ key: "o" })).toBe("set-out");
    expect(resolveWorkbenchShortcut({ key: "[" })).toBe("previous-candidate");
    expect(resolveWorkbenchShortcut({ key: "]" })).toBe("next-candidate");
  });

  it("preserves native editing and suppresses shortcuts behind modals", () => {
    expect(resolveWorkbenchShortcut({ key: "z", metaKey: true, editable: true })).toBeNull();
    expect(resolveWorkbenchShortcut({ key: " ", code: "Space", modalOpen: true })).toBeNull();
    expect(resolveWorkbenchShortcut({ key: "k", shiftKey: true })).toBeNull();
    expect(resolveWorkbenchShortcut({ key: "x" })).toBeNull();
  });
});
