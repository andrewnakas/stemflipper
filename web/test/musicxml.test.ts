import { describe, expect, it } from "vitest";
import { spell, toMusicXml } from "../src/export/musicxml";
import { buildPart, TUNINGS } from "../src/model/score";
import type { Grid, Note } from "../src/model/types";

const grid: Grid = {
  tempo: 120, time_signature: "4/4", beats: [], downbeats: [],
  tempo_map: [[0, 120]], source: "test",
};
const BEAT = 0.5;
const note = (pitch: number, b: number, len: number): Note => ({
  id: `${pitch}:${b}`, pitch, start: b * BEAT, end: (b + len) * BEAT, vel: 90, conf: 0.9,
});

/**
 * A tag-balance check. Not a schema validation, but it catches the failure that matters:
 * output that no notation program will open because the tags do not close.
 */
function wellFormed(xml: string): { ok: boolean; detail?: string } {
  const body = xml.replace(/<\?xml[^>]*\?>/, "").replace(/<!DOCTYPE[^>]*>/, "");
  const stack: string[] = [];
  const re = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const [, closing, name, , selfClose] = m;
    if (selfClose) continue;
    if (closing) {
      const open = stack.pop();
      if (open !== name) return { ok: false, detail: `</${name}> closed <${open}>` };
    } else {
      stack.push(name);
    }
  }
  return stack.length ? { ok: false, detail: `unclosed <${stack.join(">, <")}>` } : { ok: true };
}

function countDurations(xml: string, measureNumber: number): number {
  const m = xml.match(new RegExp(`<measure number="${measureNumber}">([\\s\\S]*?)</measure>`));
  if (!m) return -1;
  let total = 0;
  // A chord's notes sound together, so only the first of each chord advances time.
  for (const noteXml of m[1].match(/<note>[\s\S]*?<\/note>/g) || []) {
    if (noteXml.includes("<chord/>")) continue;
    total += Number(noteXml.match(/<duration>(\d+)<\/duration>/)?.[1] || 0);
  }
  return total;
}

describe("pitch spelling", () => {
  it("uses sharps in sharp keys and flats in flat keys", () => {
    expect(spell(61, 3)).toEqual({ step: "C", alter: 1, octave: 4 }); // C#4 in A major
    expect(spell(61, -3)).toEqual({ step: "D", alter: -1, octave: 4 }); // Db4 in Eb major
    expect(spell(60, 0)).toEqual({ step: "C", alter: 0, octave: 4 });
    expect(spell(21, 0)).toEqual({ step: "A", alter: 0, octave: 0 }); // A0, the bottom of a piano
  });
});

describe("MusicXML", () => {
  const key = { tonic: 0, mode: "major" };
  const part = buildPart("bass", "Bass", [note(40, 0, 1), note(45, 1, 1), note(47, 2, 2)], grid, key);

  it("is well-formed", () => {
    const xml = toMusicXml([{ part }], { title: "Test", tempo: 120 });
    expect(wellFormed(xml)).toEqual({ ok: true });
  });

  it("carries the things a notation program needs", () => {
    const xml = toMusicXml([{ part }], { title: "My Song", tempo: 132 });
    expect(xml).toContain("<score-partwise version=\"4.0\"");
    expect(xml).toContain("<work-title>My Song</work-title>");
    expect(xml).toContain("<part-name>Bass</part-name>");
    expect(xml).toContain("<divisions>4</divisions>");
    expect(xml).toContain("<beats>4</beats><beat-type>4</beat-type>");
    expect(xml).toContain("<sound tempo=\"132\"/>");
    expect(xml).toContain("<sign>F</sign>"); // bass range -> bass clef
  });

  it("fills each measure to exactly one bar", () => {
    const xml = toMusicXml([{ part }], { title: "T", tempo: 120 });
    expect(countDurations(xml, 1)).toBe(16); // 4 beats x 4 divisions
  });

  it("escapes a title that would otherwise break the document", () => {
    const xml = toMusicXml([{ part }], { title: 'Rock & <Roll> "1"', tempo: 120 });
    expect(xml).toContain("Rock &amp; &lt;Roll&gt;");
    expect(wellFormed(xml).ok).toBe(true);
  });

  it("ties a note that crosses a barline", () => {
    const crossing = buildPart("p", "P", [note(60, 3, 2)], grid, key);
    const xml = toMusicXml([{ part: crossing }], { title: "T", tempo: 120 });
    expect(xml).toContain('<tie type="start"/>');
    expect(xml).toContain('<tie type="stop"/>');
    expect(xml).toContain('<tied type="start"/>');
    expect(countDurations(xml, 2)).toBe(16);
  });

  it("writes a chord as one note plus <chord/> members", () => {
    const chordPart = buildPart("p", "P", [note(60, 0, 4), note(64, 0, 4), note(67, 0, 4)], grid, key);
    const xml = toMusicXml([{ part: chordPart }], { title: "T", tempo: 120 });
    expect((xml.match(/<chord\/>/g) || []).length).toBe(2); // three notes, two of them chord members
    expect(countDurations(xml, 1)).toBe(16);
  });

  it("writes drums as unpitched on a percussion staff", () => {
    const drums = buildPart("drums", "Drums", [note(36, 0, 1), note(38, 1, 1)], grid, key, { isDrum: true });
    const xml = toMusicXml([{ part: drums }], { title: "T", tempo: 120 });
    expect(xml).toContain("<sign>percussion</sign>");
    expect(xml).toContain("<unpitched>");
    expect(xml).not.toContain("<pitch>");
  });
});

describe("octave-shifted parts", () => {
  it("declares the clef sounds an octave lower, so the file still means E1", () => {
    const low = buildPart("bass", "Bass", [note(28, 0, 4)], grid, { tonic: 0, mode: "major" });
    const xml = toMusicXml([{ part: low }], { title: "T", tempo: 120 });
    expect(low.octaveShift).toBe(12);
    expect(xml).toContain("<clef-octave-change>-1</clef-octave-change>");
    // Written an octave up: E1 (28) becomes E2.
    expect(xml).toMatch(/<step>E<\/step><octave>2<\/octave>/);
    expect(wellFormed(xml).ok).toBe(true);
  });
});

describe("tablature", () => {
  const key = { tonic: 0, mode: "major" };
  const part = buildPart("bass", "Bass", [note(28, 0, 1), note(33, 1, 1), note(40, 2, 2)], grid, key);
  const xml = toMusicXml([{ part, tab: TUNINGS.bass }], { title: "T", tempo: 120 });

  it("is well-formed and uses a TAB clef", () => {
    expect(wellFormed(xml)).toEqual({ ok: true });
    expect(xml).toContain("<sign>TAB</sign>");
  });

  it("states the tuning, top string first", () => {
    expect(xml).toContain("<staff-lines>4</staff-lines>");
    // Bass E A D G listed from the top: G is line 1.
    expect(xml).toMatch(/<staff-tuning line="1"><tuning-step>G<\/tuning-step>/);
    expect(xml).toMatch(/<staff-tuning line="4"><tuning-step>E<\/tuning-step>/);
  });

  it("gives every note a string and fret", () => {
    const frets = [...xml.matchAll(/<string>(\d+)<\/string><fret>(\d+)<\/fret>/g)].map((m) => [+m[1], +m[2]]);
    expect(frets.length).toBe(3);
    expect(frets[0]).toEqual([4, 0]); // E1, open low E
    expect(frets[1]).toEqual([3, 0]); // A1, open A
    // E2 is the 12th fret of the E string, the 7th of the A, or the 2nd of the D.
    // The lowest fret wins, which keeps the part in first position.
    expect(frets[2]).toEqual([2, 2]);
  });

  it("can write notation and tab as two parts of one score", () => {
    const both = toMusicXml([{ part }, { part, tab: TUNINGS.bass }], { title: "T", tempo: 120 });
    expect(both).toContain("<part-name>Bass</part-name>");
    expect(both).toContain("<part-name>Bass (tab)</part-name>");
    expect((both.match(/<part id="P\d+">/g) || []).length).toBe(2);
    expect(wellFormed(both).ok).toBe(true);
  });
});
