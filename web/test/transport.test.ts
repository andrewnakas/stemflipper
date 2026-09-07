import { describe, expect, it } from "vitest";
import { lowerBound } from "../src/engine/transport";
import { notesFromRows, rowsFromNotes, type NoteRow } from "../src/model/types";

const rows: NoteRow[] = [
  [60, 0.0, 0.5, 100, 0.9],
  [62, 0.5, 1.0, 90, 0.8],
  [64, 1.0, 1.5, 80, 0.7],
  [65, 2.0, 2.5, 70, 0.6],
];

describe("scheduler cursor", () => {
  const notes = notesFromRows("t", rows);

  it("finds the first note at or after a time", () => {
    expect(lowerBound(notes, 0)).toBe(0);
    expect(lowerBound(notes, 0.5)).toBe(1);
    expect(lowerBound(notes, 0.75)).toBe(2);
    expect(lowerBound(notes, 5)).toBe(4);
  });

  it("handles an empty track", () => {
    expect(lowerBound([], 1)).toBe(0);
  });
});

describe("note rows", () => {
  it("round-trips through the contract shape", () => {
    const notes = notesFromRows("bass", rows);
    expect(notes[0].id).toBe("bass:0");
    expect(notes[0].pitch).toBe(60);
    expect(rowsFromNotes(notes)).toEqual(rows);
  });

  it("defaults confidence for a 4-wide legacy row", () => {
    const [n] = notesFromRows("x", [[60, 0, 1, 90] as unknown as NoteRow]);
    expect(n.conf).toBeCloseTo(0.7);
  });

  it("sorts rows on the way out", () => {
    const notes = notesFromRows("x", [
      [64, 1.0, 1.5, 80, 0.7],
      [60, 0.0, 0.5, 100, 0.9],
    ]);
    expect(rowsFromNotes(notes)[0][0]).toBe(60);
  });
});
