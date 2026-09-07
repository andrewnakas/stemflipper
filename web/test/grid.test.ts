import { describe, expect, it } from "vitest";
import { barLines, barsBeats, beatsPerBar, beatsToSeconds, secondsToBeats, snapSeconds } from "../src/model/grid";
import type { Grid } from "../src/model/types";

const steady: Grid = {
  tempo: 120,
  time_signature: "4/4",
  beats: Array.from({ length: 33 }, (_, i) => i * 0.5),
  downbeats: Array.from({ length: 9 }, (_, i) => i * 2),
  tempo_map: [[0, 120]],
  source: "librosa",
};

const drifting: Grid = { ...steady, beats: [0, 0.5, 1.0, 1.5, 2.5, 3.5], downbeats: [0, 2.5] };

describe("grid", () => {
  it("reads beats per bar from the time signature", () => {
    expect(beatsPerBar(steady)).toBe(4);
    expect(beatsPerBar({ ...steady, time_signature: "3/4" })).toBe(3);
    expect(beatsPerBar(null)).toBe(4);
  });

  it("converts seconds to beats and back", () => {
    for (const t of [0, 0.25, 1, 3.7, 9]) {
      expect(beatsToSeconds(steady, secondsToBeats(steady, t))).toBeCloseTo(t, 6);
    }
  });

  it("follows tempo drift instead of assuming a constant BPM", () => {
    // tempo halves at beat 3; a constant-BPM conversion would say 6 beats
    expect(secondsToBeats(drifting, 3.0)).toBeCloseTo(4.5, 6);
  });

  it("extrapolates outside the tracked range", () => {
    const late: Grid = { ...steady, beats: [1.0, 1.5, 2.0] };
    expect(secondsToBeats(late, 0.5)).toBeCloseTo(-1, 6);
    expect(secondsToBeats(late, 2.5)).toBeCloseTo(3, 6);
  });

  it("falls back to tempo with no beat list", () => {
    expect(secondsToBeats({ ...steady, beats: [] }, 1)).toBeCloseTo(2, 6);
  });

  it("snaps to a subdivision", () => {
    expect(snapSeconds(steady, 0.27, 4)).toBeCloseTo(0.25, 6); // 16ths
    expect(snapSeconds(steady, 0.27, 1)).toBeCloseTo(0.5, 6); // quarters
    expect(snapSeconds(steady, 0.27, 0)).toBeCloseTo(0.27, 6); // off
  });

  it("formats bars and beats from 1", () => {
    expect(barsBeats(steady, 0)).toBe("1.1.00");
    expect(barsBeats(steady, 2.0)).toBe("2.1.00");
    expect(barsBeats(steady, 2.5)).toBe("2.2.00");
  });

  it("uses downbeats for bar lines when present", () => {
    expect(barLines(steady, 8)).toEqual([0, 2, 4, 6, 8]);
  });

  it("derives bar lines from beats when downbeats are missing", () => {
    expect(barLines({ ...steady, downbeats: [] }, 4)).toEqual([0, 2, 4]);
  });
});
