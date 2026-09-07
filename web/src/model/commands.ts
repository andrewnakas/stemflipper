/** Undo/redo over note edits.
 *
 * Every edit — move, resize, draw, erase, velocity, quantise — is the same shape: a map
 * of note id to its before and after state (null means "did not exist"). One shape means
 * one undo path, and a drag can coalesce into a single history entry.
 */

import type { Note } from "./types";

export interface NoteEdit {
  trackId: string;
  before: Map<string, Note | null>;
  after: Map<string, Note | null>;
  label: string;
  coalesceKey?: string;
  at: number;
}

export function applyEdit(notes: Note[], edit: NoteEdit, direction: "do" | "undo"): Note[] {
  const target = direction === "do" ? edit.after : edit.before;
  const byId = new Map(notes.map((n) => [n.id, n]));
  for (const [id, value] of target) {
    if (value === null) byId.delete(id);
    else byId.set(id, value);
  }
  return [...byId.values()].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

const COALESCE_MS = 500;

export class History {
  private undoStack: NoteEdit[] = [];
  private redoStack: NoteEdit[] = [];

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get depth(): number {
    return this.undoStack.length;
  }

  /** Record an edit. Consecutive edits with the same key merge into one entry. */
  push(edit: NoteEdit): void {
    const top = this.undoStack[this.undoStack.length - 1];
    if (
      top &&
      edit.coalesceKey &&
      top.coalesceKey === edit.coalesceKey &&
      top.trackId === edit.trackId &&
      edit.at - top.at < COALESCE_MS
    ) {
      // keep the ORIGINAL before-state so one undo reverts the whole gesture
      for (const [id, value] of edit.after) top.after.set(id, value);
      for (const [id, value] of edit.before) if (!top.before.has(id)) top.before.set(id, value);
      top.at = edit.at;
    } else {
      this.undoStack.push(edit);
    }
    this.redoStack = [];
  }

  undo(): NoteEdit | null {
    const edit = this.undoStack.pop();
    if (!edit) return null;
    this.redoStack.push(edit);
    return edit;
  }

  redo(): NoteEdit | null {
    const edit = this.redoStack.pop();
    if (!edit) return null;
    this.undoStack.push(edit);
    return edit;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}

/** Build an edit from the notes a gesture touched. */
export function editFrom(
  trackId: string,
  label: string,
  changes: { id: string; before: Note | null; after: Note | null }[],
  coalesceKey?: string,
): NoteEdit {
  return {
    trackId,
    label,
    coalesceKey,
    at: Date.now(),
    before: new Map(changes.map((c) => [c.id, c.before])),
    after: new Map(changes.map((c) => [c.id, c.after])),
  };
}
