import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ANNOTATIONS_FPS, BP_HOP_SIZE, BP_N_SAMPLES, BP_OVERLAP_LEN,
  notesFromOutputs, unwrapWindows, windowsFor, type Matrix,
} from "../src/local/basicPitch";

/**
 * Cases produced by running basic-pitch's OWN output_to_notes_polyphonic
 * (spotify/basic-pitch note_creation.py) over synthetic activations.
 * The server tuned its thresholds against that algorithm, so the browser has to agree
 * with it — a note-tracker that is merely plausible would give different MIDI for the
 * same song depending on where it ran.
 */
const cases = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/basic_pitch_notes.json", import.meta.url)), "utf8"),
) as { frames: number[]; onsets: number[]; rows: number; notes: [number, number, number, number][] }[];

function matrix(flat: number[], rows: number): Matrix {
  return { data: Float32Array.from(flat), rows, cols: 88 };
}

describe("note extraction matches basic-pitch's own implementation", () => {
  it("has reference cases with real notes in them", () => {
    expect(cases).toHaveLength(3);
    expect(cases.reduce((n, c) => n + c.notes.length, 0)).toBeGreaterThan(200);
  });

  for (const [i, c] of cases.entries()) {
    it(`agrees on case ${i} (${c.rows} frames, ${c.notes.length} notes)`, () => {
      const mine = notesFromOutputs(matrix(c.frames, c.rows), matrix(c.onsets, c.rows), {
        onsetThreshold: 0.5,
        frameThreshold: 0.3,
        minNoteLength: (11 / ANNOTATIONS_FPS) * 1000, // the Python was called with 11 frames
        inferOnsets: true,
        energyTolerance: 11,
      });

      // Compare in frame indices, which is what the reference returns.
      const got = mine
        .map((n) => [Math.round(n.start * ANNOTATIONS_FPS), Math.round(n.end * ANNOTATIONS_FPS), n.pitch])
        .sort((a, b) => a[0] - b[0] || a[2] - b[2]);
      const want = c.notes
        .map(([s, e, p]) => [s, e, p])
        .sort((a, b) => a[0] - b[0] || a[2] - b[2]);

      expect(got).toEqual(want);
    });

    it(`agrees on case ${i}'s amplitudes`, () => {
      const mine = notesFromOutputs(matrix(c.frames, c.rows), matrix(c.onsets, c.rows), {
        minNoteLength: (11 / ANNOTATIONS_FPS) * 1000,
      });
      const byKey = new Map(
        c.notes.map(([s, , p, amp]) => [`${s}:${p}`, amp] as const),
      );
      for (const n of mine) {
        const want = byKey.get(`${Math.round(n.start * ANNOTATIONS_FPS)}:${n.pitch}`);
        expect(want, `no reference note at ${n.start}s pitch ${n.pitch}`).toBeDefined();
        expect(n.amplitude).toBeCloseTo(want!, 4);
      }
    });
  }
});

describe("windowing", () => {
  it("uses the model's own geometry", () => {
    expect(BP_N_SAMPLES).toBe(43844);
    expect(BP_OVERLAP_LEN).toBe(7680);
    expect(BP_HOP_SIZE).toBe(36164);
    expect(ANNOTATIONS_FPS).toBeCloseTo(86.1328125, 6);
  });

  it("pads the front by half the overlap, so the first note is not clipped", () => {
    const mono = new Float32Array(BP_N_SAMPLES);
    mono.fill(1);
    const w = windowsFor(mono);
    expect(w[0].subarray(0, BP_OVERLAP_LEN / 2).every((v) => v === 0)).toBe(true);
    expect(w[0][BP_OVERLAP_LEN / 2]).toBe(1);
  });

  it("covers the whole signal and pads the last window", () => {
    const mono = new Float32Array(BP_HOP_SIZE * 3 + 500);
    const w = windowsFor(mono);
    expect(w.length).toBeGreaterThanOrEqual(3);
    for (const win of w) expect(win.length).toBe(BP_N_SAMPLES);
  });

  it("trims the overlap when stitching, so boundaries do not duplicate", () => {
    const cols = 88;
    const per = 172 * cols;
    const a = new Float32Array(per).fill(1);
    const b = new Float32Array(per).fill(2);
    const m = unwrapWindows([a, b], cols, BP_HOP_SIZE * 2);
    expect(m.cols).toBe(cols);
    // 172 frames minus 15 trimmed from each end = 142 kept per window
    expect(m.rows).toBeLessThanOrEqual(142 * 2);
    expect(m.rows).toBeGreaterThan(142);
  });
});
