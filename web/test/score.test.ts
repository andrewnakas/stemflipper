import { describe, expect, it } from "vitest";
import {
  buildPart, clefFor, DIVISIONS_PER_BEAT, fifthsFor, splitDuration, tabPosition, TUNINGS, tuningFor,
} from "../src/model/score";
import type { Grid, Note } from "../src/model/types";

const grid: Grid = {
  tempo: 120,
  time_signature: "4/4",
  beats: [],
  downbeats: [],
  tempo_map: [[0, 120]],
  source: "test",
};
const BEAT = 0.5; // seconds, at 120 BPM

function note(pitch: number, startBeats: number, lenBeats: number): Note {
  return {
    id: `n${pitch}:${startBeats}`,
    pitch,
    start: startBeats * BEAT,
    end: (startBeats + lenBeats) * BEAT,
    vel: 90,
    conf: 0.9,
  };
}

describe("note values", () => {
  it("writes a duration that has no single symbol as tied notes", () => {
    // Five sixteenths is a quarter tied to a sixteenth. Rounding it to one symbol would
    // silently change the rhythm.
    expect(splitDuration(5).map((v) => `${v.type}${v.dots ? "." : ""}`)).toEqual(["quarter", "16th"]);
    expect(splitDuration(4).map((v) => v.type)).toEqual(["quarter"]);
    expect(splitDuration(6).map((v) => `${v.type}${v.dots ? "." : ""}`)).toEqual(["quarter."]);
    expect(splitDuration(16).map((v) => v.type)).toEqual(["whole"]);
    expect(splitDuration(2).map((v) => v.type)).toEqual(["eighth"]);
  });

  it("always accounts for the whole duration", () => {
    for (let d = 1; d <= 32; d++) {
      const total = splitDuration(d).reduce((n, v) => n + v.divs, 0);
      expect(total, `${d} divisions`).toBe(d);
    }
  });
});

describe("key signatures", () => {
  it("places keys on the circle of fifths", () => {
    expect(fifthsFor(0, "major")).toBe(0); // C
    expect(fifthsFor(7, "major")).toBe(1); // G
    expect(fifthsFor(5, "major")).toBe(-1); // F
    expect(fifthsFor(9, "minor")).toBe(0); // A minor shares C major's signature
    expect(fifthsFor(4, "minor")).toBe(1); // E minor, one sharp
    expect(fifthsFor(null, null)).toBe(0);
  });
});

describe("clefs", () => {
  it("follows the range, and gives drums a percussion staff", () => {
    expect(clefFor([note(40, 0, 1), note(45, 1, 1)], false)).toBe("bass");
    expect(clefFor([note(72, 0, 1), note(76, 1, 1)], false)).toBe("treble");
    expect(clefFor([note(36, 0, 1)], true)).toBe("percussion");
    expect(clefFor([], false)).toBe("treble");
  });
});

describe("building measures", () => {
  const key = { tonic: 0, mode: "major" };

  it("lays four quarter notes into one bar of 4/4", () => {
    const notes = [0, 1, 2, 3].map((b) => note(60 + b, b, 1));
    const part = buildPart("p", "P", notes, grid, key);
    expect(part.measures).toHaveLength(1);
    const sounded = part.measures[0].events.filter((e) => e.pitches.length);
    expect(sounded).toHaveLength(4);
    expect(sounded.every((e) => e.duration === DIVISIONS_PER_BEAT)).toBe(true);
  });

  it("fills every measure exactly, rests included", () => {
    // The invariant that catches every off-by-one: a bar that does not add up is a bar
    // no engraver can draw.
    const notes = [note(60, 0, 1), note(62, 2.5, 0.5), note(64, 6, 2), note(65, 11.25, 0.75)];
    const part = buildPart("p", "P", notes, grid, key);
    const perMeasure = part.beatsPerBar * part.divisions;
    expect(part.measures.length).toBeGreaterThan(2);
    for (const m of part.measures) {
      const total = m.events.reduce((n, e) => n + e.duration, 0);
      expect(total, `measure ${m.index + 1}`).toBe(perMeasure);
      // and they must be contiguous from 0
      let cursor = 0;
      for (const e of m.events) {
        expect(e.start).toBe(cursor);
        cursor += e.duration;
      }
    }
  });

  it("ties a note that crosses a barline instead of losing it", () => {
    const part = buildPart("p", "P", [note(60, 3, 2)], grid, key); // beat 3 to beat 5
    expect(part.measures.length).toBeGreaterThanOrEqual(2);
    const first = part.measures[0].events.find((e) => e.pitches.length)!;
    const second = part.measures[1].events.find((e) => e.pitches.length)!;
    expect(first.tiedTo).toBe(true);
    expect(second.tiedFrom).toBe(true);
    expect(first.duration + second.duration).toBe(2 * DIVISIONS_PER_BEAT);
  });

  it("makes a chord of notes that start together", () => {
    const part = buildPart("p", "P", [note(60, 0, 2), note(64, 0, 2), note(67, 0, 2)], grid, key);
    const ev = part.measures[0].events.find((e) => e.pitches.length)!;
    expect(ev.pitches).toEqual([60, 64, 67]);
  });

  it("cuts a note short when the next one starts, keeping one voice", () => {
    const part = buildPart("p", "P", [note(60, 0, 4), note(62, 1, 1)], grid, key);
    const sounded = part.measures[0].events.filter((e) => e.pitches.length);
    expect(sounded[0].duration).toBe(DIVISIONS_PER_BEAT); // clipped from 4 beats to 1
    expect(sounded[1].pitches).toEqual([62]);
  });

  it("produces a valid empty bar for a silent part", () => {
    const part = buildPart("p", "P", [], grid, key);
    expect(part.measures).toHaveLength(1);
    expect(part.measures[0].events.every((e) => e.pitches.length === 0)).toBe(true);
    expect(part.measures[0].events.reduce((n, e) => n + e.duration, 0)).toBe(16);
  });
});

describe("tablature", () => {
  it("puts an open low E on the sixth string", () => {
    expect(tabPosition(40, TUNINGS.guitar)).toEqual({ string: 6, fret: 0 });
  });

  it("prefers the lowest fret, which keeps a part in first position", () => {
    // A2 is the fifth fret of the sixth string or the open fifth; open wins.
    expect(tabPosition(45, TUNINGS.guitar)).toEqual({ string: 5, fret: 0 });
  });

  it("knows what is off the instrument", () => {
    expect(tabPosition(20, TUNINGS.guitar)).toBeNull();
    expect(tabPosition(120, TUNINGS.guitar)).toBeNull();
  });

  it("chooses bass or guitar by range", () => {
    expect(tuningFor([note(30, 0, 1), note(40, 1, 1)])?.name).toMatch(/Bass/);
    expect(tuningFor([note(45, 0, 1), note(64, 1, 1)])?.name).toMatch(/Guitar/);
    // A high line is still offered as guitar tab — MIDI 80 is the 16th fret of the top
    // string, and putting a sung melody on the neck is a thing people do.
    expect(tuningFor([note(80, 0, 1)])?.name).toMatch(/Guitar/);
  });

  it("declines when the part is off both instruments", () => {
    expect(tuningFor([note(96, 0, 1)])).toBeNull(); // above the top string plus 20 frets
    expect(tuningFor([note(20, 0, 1)])).toBeNull(); // below a bass low E
    expect(tuningFor([])).toBeNull();
  });
});

describe("octave shift", () => {
  const key = { tonic: 0, mode: "major" };

  it("writes a low bass part an octave up, as real bass notation does", () => {
    // E1 at concert pitch needs four ledger lines under the bass clef and is unreadable.
    const part = buildPart("bass", "Bass", [note(28, 0, 1), note(33, 1, 1)], grid, key);
    expect(part.octaveShift).toBe(12);
    expect(part.clef).toBe("bass");
  });

  it("leaves a part that already sits on its staff alone", () => {
    expect(buildPart("p", "P", [note(48, 0, 1), note(60, 1, 1)], grid, key).octaveShift).toBe(0);
    expect(buildPart("p", "P", [note(72, 0, 1)], grid, key).octaveShift).toBe(0);
  });

  it("never shifts drums, which are positions not pitches", () => {
    expect(buildPart("d", "D", [note(36, 0, 1)], grid, key, { isDrum: true }).octaveShift).toBe(0);
  });
});
