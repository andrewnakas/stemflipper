import { describe, expect, it } from "vitest";
import { History, applyEdit, editFrom } from "../src/model/commands";
import {
  MIN_LENGTH_S, addNote, deleteNotes, moveNotes, noteAt, notesIn, quantizeNotes,
  resizeNotes, setVelocity,
} from "../src/model/notes";
import type { Grid, Note } from "../src/model/types";

const grid: Grid = {
  tempo: 120, time_signature: "4/4",
  beats: Array.from({ length: 33 }, (_, i) => i * 0.5),
  downbeats: Array.from({ length: 9 }, (_, i) => i * 2),
  tempo_map: [[0, 120]], source: "test",
};

const notes: Note[] = [
  { id: "a", pitch: 60, start: 0, end: 0.5, vel: 100, conf: 0.9 },
  { id: "b", pitch: 64, start: 1, end: 1.5, vel: 80, conf: 0.8 },
];

const ids = (...v: string[]) => new Set(v);

describe("note operations", () => {
  it("moves in time and pitch, snapping to the grid", () => {
    const [c] = moveNotes(notes, ids("a"), 0.27, 2, grid, 4);
    expect(c.after!.start).toBeCloseTo(0.25); // snapped to a 16th
    expect(c.after!.pitch).toBe(62);
    expect(c.after!.end - c.after!.start).toBeCloseTo(0.5); // length preserved
  });

  it("does not move a note before zero", () => {
    const [c] = moveNotes(notes, ids("a"), -5, 0, grid, 0);
    expect(c.after!.start).toBe(0);
  });

  it("clamps pitch to the MIDI range", () => {
    const [c] = moveNotes(notes, ids("a"), 0, 200, grid, 0);
    expect(c.after!.pitch).toBe(127);
  });

  it("resizes from either edge and keeps a minimum length", () => {
    const [end] = resizeNotes(notes, ids("a"), 0.5, "end", grid, 0);
    expect(end.after!.end).toBeCloseTo(1.0);
    const [start] = resizeNotes(notes, ids("a"), 5, "start", grid, 0);
    expect(start.after!.end - start.after!.start).toBeGreaterThanOrEqual(MIN_LENGTH_S);
  });

  it("adds a note on the grid", () => {
    const c = addNote("bass", 48, 0.27, 0.5, 90, grid, 4);
    expect(c.before).toBeNull();
    expect(c.after!.start).toBeCloseTo(0.25);
    expect(c.after!.pitch).toBe(48);
  });

  it("deletes and sets velocity", () => {
    expect(deleteNotes(notes, ids("a"))[0].after).toBeNull();
    expect(setVelocity(notes, ids("a", "b"), 64).every((c) => c.after!.vel === 64)).toBe(true);
  });

  it("quantises only what is off the grid", () => {
    const off: Note[] = [
      { id: "x", pitch: 60, start: 0.27, end: 0.6, vel: 90, conf: 1 },
      { id: "y", pitch: 62, start: 0.5, end: 0.9, vel: 90, conf: 1 },
    ];
    const changes = quantizeNotes(off, ids("x", "y"), grid, 4);
    expect(changes.length).toBe(1);
    expect(changes[0].id).toBe("x");
    expect(changes[0].after!.start).toBeCloseTo(0.25);
  });

  it("selects notes inside a rectangle", () => {
    expect(notesIn(notes, 0, 0.6, 55, 65).map((n) => n.id)).toEqual(["a"]);
    expect(notesIn(notes, 0, 2, 0, 127).length).toBe(2);
  });

  it("hit-tests a note at a point", () => {
    expect(noteAt(notes, 0.2, 60)?.id).toBe("a");
    expect(noteAt(notes, 0.2, 70)).toBeNull();
    expect(noteAt(notes, 5, 60)).toBeNull();
  });
});

describe("history", () => {
  it("applies and reverts an edit", () => {
    const edit = editFrom("t", "delete", deleteNotes(notes, ids("a")));
    const after = applyEdit(notes, edit, "do");
    expect(after.map((n) => n.id)).toEqual(["b"]);
    expect(applyEdit(after, edit, "undo").map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("round-trips an added note", () => {
    const change = addNote("t", 48, 2, 0.5, 90, grid, 0);
    const edit = editFrom("t", "add", [change]);
    const added = applyEdit(notes, edit, "do");
    expect(added.length).toBe(3);
    expect(applyEdit(added, edit, "undo").length).toBe(2);
  });

  it("undoes and redoes in order", () => {
    const h = new History();
    expect(h.canUndo).toBe(false);
    h.push(editFrom("t", "one", deleteNotes(notes, ids("a"))));
    h.push(editFrom("t", "two", deleteNotes(notes, ids("b"))));
    expect(h.depth).toBe(2);
    expect(h.undo()!.label).toBe("two");
    expect(h.undo()!.label).toBe("one");
    expect(h.undo()).toBeNull();
    expect(h.redo()!.label).toBe("one");
  });

  it("coalesces a drag into one undo step", () => {
    const h = new History();
    for (let i = 0; i < 8; i++) {
      h.push(editFrom("t", "move", moveNotes(notes, ids("a"), i * 0.01, 0, grid, 0), "drag:a"));
    }
    expect(h.depth).toBe(1);
    // and one undo returns the ORIGINAL position, not the previous drag frame
    const edit = h.undo()!;
    expect(applyEdit(notes, edit, "undo").find((n) => n.id === "a")!.start).toBe(0);
  });

  it("does not coalesce across different gestures", () => {
    const h = new History();
    h.push(editFrom("t", "move", moveNotes(notes, ids("a"), 0.1, 0, grid, 0), "drag:a"));
    h.push(editFrom("t", "move", moveNotes(notes, ids("b"), 0.1, 0, grid, 0), "drag:b"));
    expect(h.depth).toBe(2);
  });

  it("a new edit clears the redo stack", () => {
    const h = new History();
    h.push(editFrom("t", "one", deleteNotes(notes, ids("a"))));
    h.undo();
    expect(h.canRedo).toBe(true);
    h.push(editFrom("t", "two", deleteNotes(notes, ids("b"))));
    expect(h.canRedo).toBe(false);
  });
});
