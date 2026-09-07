/** Pure note operations. Every one returns the changes, so the caller can undo them. */

import type { Grid, Note } from "./types";
import { snapSeconds } from "./grid";

export const MIN_LENGTH_S = 0.02;

export interface Change {
  id: string;
  before: Note | null;
  after: Note | null;
}

let counter = 0;

export function newNoteId(trackId: string): string {
  return `${trackId}:new:${++counter}`;
}

function clampNote(n: Note): Note {
  const pitch = Math.max(0, Math.min(127, Math.round(n.pitch)));
  const start = Math.max(0, n.start);
  const end = Math.max(start + MIN_LENGTH_S, n.end);
  return { ...n, pitch, start, end, vel: Math.max(1, Math.min(127, Math.round(n.vel))) };
}

export function moveNotes(
  notes: Note[],
  ids: Set<string>,
  deltaTime: number,
  deltaPitch: number,
  grid: Grid | null,
  snapDivision: number,
): Change[] {
  const changes: Change[] = [];
  for (const n of notes) {
    if (!ids.has(n.id)) continue;
    const length = n.end - n.start;
    let start = n.start + deltaTime;
    if (snapDivision > 0) start = snapSeconds(grid, start, snapDivision);
    start = Math.max(0, start);
    changes.push({
      id: n.id,
      before: n,
      after: clampNote({ ...n, start, end: start + length, pitch: n.pitch + deltaPitch }),
    });
  }
  return changes;
}

export function resizeNotes(
  notes: Note[],
  ids: Set<string>,
  deltaTime: number,
  edge: "start" | "end",
  grid: Grid | null,
  snapDivision: number,
): Change[] {
  const changes: Change[] = [];
  for (const n of notes) {
    if (!ids.has(n.id)) continue;
    let start = n.start;
    let end = n.end;
    if (edge === "end") {
      end += deltaTime;
      if (snapDivision > 0) end = snapSeconds(grid, end, snapDivision);
      end = Math.max(start + MIN_LENGTH_S, end);
    } else {
      start += deltaTime;
      if (snapDivision > 0) start = snapSeconds(grid, start, snapDivision);
      start = Math.max(0, Math.min(start, end - MIN_LENGTH_S));
    }
    changes.push({ id: n.id, before: n, after: clampNote({ ...n, start, end }) });
  }
  return changes;
}

export function addNote(
  trackId: string,
  pitch: number,
  start: number,
  length: number,
  vel: number,
  grid: Grid | null,
  snapDivision: number,
): Change {
  const snapped = snapDivision > 0 ? snapSeconds(grid, start, snapDivision) : start;
  const note = clampNote({
    id: newNoteId(trackId),
    pitch,
    start: Math.max(0, snapped),
    end: Math.max(0, snapped) + Math.max(MIN_LENGTH_S, length),
    vel,
    conf: 1,
  });
  return { id: note.id, before: null, after: note };
}

export function deleteNotes(notes: Note[], ids: Set<string>): Change[] {
  return notes.filter((n) => ids.has(n.id)).map((n) => ({ id: n.id, before: n, after: null }));
}

export function setVelocity(notes: Note[], ids: Set<string>, vel: number): Change[] {
  return notes
    .filter((n) => ids.has(n.id))
    .map((n) => ({ id: n.id, before: n, after: clampNote({ ...n, vel }) }));
}

export function quantizeNotes(
  notes: Note[],
  ids: Set<string>,
  grid: Grid | null,
  division: number,
): Change[] {
  if (division <= 0) return [];
  const changes: Change[] = [];
  for (const n of notes) {
    if (!ids.has(n.id)) continue;
    const start = snapSeconds(grid, n.start, division);
    if (Math.abs(start - n.start) < 1e-6) continue;
    changes.push({
      id: n.id,
      before: n,
      after: clampNote({ ...n, start: Math.max(0, start), end: Math.max(0, start) + (n.end - n.start) }),
    });
  }
  return changes;
}

/** Notes intersecting a rectangle in (time, pitch) space. */
export function notesIn(
  notes: Note[],
  t0: number,
  t1: number,
  p0: number,
  p1: number,
): Note[] {
  const [ta, tb] = t0 <= t1 ? [t0, t1] : [t1, t0];
  const [pa, pb] = p0 <= p1 ? [p0, p1] : [p1, p0];
  return notes.filter((n) => n.end >= ta && n.start <= tb && n.pitch >= pa && n.pitch <= pb);
}

export function noteAt(notes: Note[], t: number, pitch: number, pitchTol = 0.5): Note | null {
  let best: Note | null = null;
  for (const n of notes) {
    if (t < n.start || t > n.end) continue;
    if (Math.abs(n.pitch - pitch) > pitchTol) continue;
    if (!best || n.start > best.start) best = n;
  }
  return best;
}
