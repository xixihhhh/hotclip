import type { SessionEditCommand, SessionEditHistory } from "./api-types";

export const SESSION_EDIT_HISTORY_MAX_COMMANDS = 60;
export const SESSION_EDIT_HISTORY_MAX_BYTES = 4 * 1024 * 1024;

export function emptySessionEditHistory(): SessionEditHistory {
  return { undo: [], redo: [] };
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** Keep the nearest undo/redo commands while enforcing both history budgets. */
export function compactSessionEditHistory(history: SessionEditHistory): SessionEditHistory {
  const undo = history.undo.slice();
  const redo = history.redo.slice();
  while (undo.length + redo.length > SESSION_EDIT_HISTORY_MAX_COMMANDS) {
    if (undo.length > 0) undo.shift();
    else redo.shift();
  }
  while (undo.length + redo.length > 0 && byteLength({ undo, redo }) > SESSION_EDIT_HISTORY_MAX_BYTES) {
    if (undo.length > 0) undo.shift();
    else redo.shift();
  }
  return { undo, redo };
}

/** New human edits always invalidate the redo branch. Oversized commands are safely omitted. */
export function appendSessionEdit(history: SessionEditHistory, command: SessionEditCommand): SessionEditHistory {
  return compactSessionEditHistory({ undo: [...history.undo, command], redo: [] });
}
