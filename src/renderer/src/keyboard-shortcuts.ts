export type WorkbenchShortcut =
  | "undo"
  | "redo"
  | "toggle-play"
  | "back-5"
  | "forward-5"
  | "set-in"
  | "set-out"
  | "previous-candidate"
  | "next-candidate";

export interface ShortcutInput {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  editable?: boolean;
  modalOpen?: boolean;
}

/** Pure key router so platform modifiers and input/modal guards stay testable. */
export function resolveWorkbenchShortcut(input: ShortcutInput): WorkbenchShortcut | null {
  if (input.editable || input.modalOpen) return null;
  const key = input.key.toLowerCase();
  const primary = Boolean(input.metaKey || input.ctrlKey);
  if (primary && !input.altKey && key === "z") return input.shiftKey ? "redo" : "undo";
  if (input.ctrlKey && !input.metaKey && !input.altKey && !input.shiftKey && key === "y") return "redo";
  if (primary || input.altKey || input.shiftKey) return null;
  if (input.code === "Space" || input.key === " " || key === "k") return "toggle-play";
  if (key === "j") return "back-5";
  if (key === "l") return "forward-5";
  if (key === "i") return "set-in";
  if (key === "o") return "set-out";
  if (input.key === "[") return "previous-candidate";
  if (input.key === "]") return "next-candidate";
  return null;
}
