/**
 * Note editing gestures, lifted out of App.tsx unchanged in behaviour.
 *
 * One thing did change: the marquee is a signal now. It used to be a plain module object
 * and the drag handler forced a repaint with `playhead.value = playhead.value`, which
 * only worked by accident.
 */

import { signal } from "@preact/signals";
import {
  addNote, deleteNotes, moveNotes, notesIn, quantizeNotes, resizeNotes, setVelocity,
  type Change,
} from "../../model/notes";
import {
  commitEdit, notesByTrack, previewEdit, project, selectedTrack, selection, snapDivision,
} from "../../model/store";
import type { Note } from "../../model/types";
import type { RollGesture } from "../PianoRoll";

export interface MarqueeRect {
  t0: number;
  t1: number;
  p0: number;
  p1: number;
}

export const marquee = signal<{ track: string; rect: MarqueeRect } | null>(null);

/** Drag state for an edit in progress. */
const gesture: {
  kind: RollGesture["kind"] | null;
  trackId: string;
  from: { time: number; pitch: number };
  baseline: Note[];
  ids: Set<string>;
  key: string;
} = { kind: null, trackId: "", from: { time: 0, pitch: 0 }, baseline: [], ids: new Set(), key: "" };

export function startGesture(trackId: string, notes: Note[], g: RollGesture): void {
  selectedTrack.value = trackId;
  gesture.trackId = trackId;
  gesture.from = { time: g.time, pitch: g.pitch };
  gesture.baseline = notes.map((n) => ({ ...n }));
  gesture.key = `${g.kind}:${trackId}:${Date.now()}`;

  if (g.kind === "erase") {
    if (g.noteId) commitEdit(trackId, "erase", deleteNotes(notes, new Set([g.noteId])));
    gesture.kind = null;
    return;
  }
  if (g.kind === "draw") {
    const grid = project.value!.grid;
    const beat = 60 / (grid.tempo || 120);
    const length = snapDivision.value > 0 ? beat / snapDivision.value : beat / 4;
    const change = addNote(trackId, g.pitch, g.time, length, 96, grid, snapDivision.value);
    commitEdit(trackId, "draw", [change]);
    selection.value = new Set([change.id]);
    gesture.kind = null;
    return;
  }
  if (g.kind === "marquee") {
    if (!g.additive) selection.value = new Set();
    marquee.value = { track: trackId, rect: { t0: g.time, t1: g.time, p0: g.pitch, p1: g.pitch } };
    gesture.kind = "marquee";
    return;
  }

  // move / resize: make sure the grabbed note is selected
  let ids = new Set(selection.value);
  if (g.noteId && !ids.has(g.noteId)) {
    ids = g.additive ? new Set([...ids, g.noteId]) : new Set([g.noteId]);
  }
  selection.value = ids;
  gesture.ids = ids;
  gesture.kind = g.kind;
}

export function moveGesture(trackId: string, time: number, pitch: number): void {
  const active = marquee.value;
  if (gesture.kind === "marquee" && active && active.track === trackId) {
    const rect = { ...active.rect, t1: time, p1: pitch };
    marquee.value = { track: trackId, rect };
    const hits = notesIn(notesByTrack.value[trackId] || [], rect.t0, rect.t1, rect.p0, rect.p1);
    selection.value = new Set(hits.map((n) => n.id));
    return;
  }
  if (!gesture.kind || gesture.trackId !== trackId || !gesture.ids.size) return;

  const grid = project.value!.grid;
  const dt = time - gesture.from.time;
  const dp = Math.round(pitch - gesture.from.pitch);
  let changes: Change[] = [];
  if (gesture.kind === "move") {
    changes = moveNotes(gesture.baseline, gesture.ids, dt, dp, grid, snapDivision.value);
  } else if (gesture.kind === "resize-end") {
    changes = resizeNotes(gesture.baseline, gesture.ids, dt, "end", grid, snapDivision.value);
  } else if (gesture.kind === "resize-start") {
    changes = resizeNotes(gesture.baseline, gesture.ids, dt, "start", grid, snapDivision.value);
  }
  if (changes.length) previewEdit(trackId, changes);
}

export function endGesture(): void {
  if (gesture.kind === "marquee") {
    marquee.value = null;
    gesture.kind = null;
    return;
  }
  if (!gesture.kind) return;
  // commit the whole drag as ONE undo step, from the pre-drag baseline
  const current = notesByTrack.value[gesture.trackId] || [];
  const byId = new Map(current.map((n) => [n.id, n]));
  const changes: Change[] = [];
  for (const before of gesture.baseline) {
    const after = byId.get(before.id);
    if (!after) continue;
    if (
      after.start !== before.start || after.end !== before.end ||
      after.pitch !== before.pitch || after.vel !== before.vel
    ) {
      changes.push({ id: before.id, before, after });
    }
  }
  gesture.kind = null;
  if (changes.length) commitEdit(gesture.trackId, "edit", changes, gesture.key);
}

export function deleteSelection(): void {
  const trackId = selectedTrack.value;
  if (!trackId || !selection.value.size) return;
  const notes = notesByTrack.value[trackId] || [];
  commitEdit(trackId, "delete", deleteNotes(notes, selection.value));
  selection.value = new Set();
}

export function quantizeSelection(): void {
  const trackId = selectedTrack.value;
  if (!trackId) return;
  const notes = notesByTrack.value[trackId] || [];
  const ids = selection.value.size ? selection.value : new Set(notes.map((n) => n.id));
  const division = snapDivision.value || 4;
  commitEdit(trackId, "quantise", quantizeNotes(notes, ids, project.value!.grid, division));
}

export function nudgeVelocity(delta: number): void {
  const trackId = selectedTrack.value;
  if (!trackId || !selection.value.size) return;
  const notes = notesByTrack.value[trackId] || [];
  const current = notes.find((n) => selection.value.has(n.id));
  if (!current) return;
  commitEdit(trackId, "velocity", setVelocity(notes, selection.value, current.vel + delta));
}
