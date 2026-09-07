import { describe, expect, it } from "vitest";
import { parseMidi } from "midi-file";
import { writeMidi } from "../src/export/midi";
import type { Grid, Note } from "../src/model/types";

const grid: Grid = {
  tempo: 120,
  time_signature: "4/4",
  beats: Array.from({ length: 33 }, (_, i) => i * 0.5),
  downbeats: Array.from({ length: 9 }, (_, i) => i * 2),
  tempo_map: [[0, 120]],
  source: "test",
};

function note(id: string, pitch: number, start: number, end: number, vel = 100): Note {
  return { id, pitch, start, end, vel, conf: 0.9 };
}

const tracks = [
  { name: "bass", isDrum: false, notes: [note("a", 33, 0, 0.5), note("b", 36, 1, 1.5)] },
  { name: "drums", isDrum: true, notes: [note("c", 36, 0, 0.1, 110)] },
];

describe("midi export", () => {
  it("writes a parseable format-1 file", () => {
    const parsed = parseMidi(writeMidi(tracks, grid));
    expect(parsed.header.format).toBe(1);
    expect(parsed.header.ticksPerBeat).toBe(480);
    expect(parsed.tracks.length).toBe(3); // tempo + 2 note tracks
  });

  it("carries tempo and time signature", () => {
    const parsed = parseMidi(writeMidi(tracks, grid));
    const meta = parsed.tracks[0];
    const tempo = meta.find((e) => e.type === "setTempo") as any;
    const sig = meta.find((e) => e.type === "timeSignature") as any;
    expect(Math.round(60_000_000 / tempo.microsecondsPerBeat)).toBe(120);
    expect(sig.numerator).toBe(4);
    expect(sig.denominator).toBe(4);
  });

  it("writes a tempo event per breakpoint on a drifting song", () => {
    const drifting: Grid = { ...grid, tempo_map: [[0, 120], [4, 132], [8, 126]] };
    const parsed = parseMidi(writeMidi(tracks, drifting));
    expect(parsed.tracks[0].filter((e) => e.type === "setTempo").length).toBe(3);
  });

  it("puts notes at the right musical positions", () => {
    const parsed = parseMidi(writeMidi(tracks, grid));
    const bass = parsed.tracks[1];
    const ons = bass.filter((e) => e.type === "noteOn") as any[];
    expect(ons.map((e) => e.noteNumber)).toEqual([33, 36]);
    // second note starts on beat 2 => 480 ticks after the first note's release
    const ticks: number[] = [];
    let t = 0;
    for (const e of bass) {
      t += e.deltaTime;
      if (e.type === "noteOn") ticks.push(t);
    }
    expect(ticks).toEqual([0, 960]);
  });

  it("puts drums on MIDI channel 10", () => {
    const parsed = parseMidi(writeMidi(tracks, grid));
    const drums = parsed.tracks[2].filter((e) => e.type === "noteOn") as any[];
    expect(drums[0].channel).toBe(9);
  });

  it("writes section markers", () => {
    const parsed = parseMidi(writeMidi(tracks, grid, [{ start: 0, label: "A" }, { start: 4, label: "B" }]));
    const markers = parsed.tracks[0].filter((e) => e.type === "marker") as any[];
    expect(markers.map((m) => m.text)).toEqual(["A", "B"]);
  });

  it("skips empty tracks", () => {
    const parsed = parseMidi(writeMidi([{ name: "empty", isDrum: false, notes: [] }], grid));
    expect(parsed.tracks.length).toBe(1);
  });

  it("clamps out-of-range pitch and velocity", () => {
    const wild = [{ name: "x", isDrum: false, notes: [note("z", 300, 0, 1, 999)] }];
    const parsed = parseMidi(writeMidi(wild, grid));
    const on = parsed.tracks[1].find((e) => e.type === "noteOn") as any;
    expect(on.noteNumber).toBeLessThanOrEqual(127);
    expect(on.velocity).toBeLessThanOrEqual(127);
  });
});
