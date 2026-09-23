/**
 * Turning transcribed notes into something that can be written down.
 *
 * The notes are raw transcription: onsets in seconds, durations that are whatever the
 * model heard. Notation needs the opposite — a rhythmic grid, note values, rests, bar
 * lines and ties. This is that conversion, kept pure so the arithmetic can be tested
 * without a renderer.
 *
 * Simplifications, stated rather than hidden:
 *  - one voice per staff. Notes that start together become a chord; a note still sounding
 *    when the next one starts is cut short. Real multi-voice engraving is a different
 *    problem and the transcription is rarely clean enough to justify it.
 *  - durations snap to the subdivision, so a swung or rubato performance is written as
 *    what it is closest to. The piano roll remains the truthful view.
 */

import { beatsPerBar, secondsToBeats } from "./grid";
import type { Grid, Note } from "./types";

export const DIVISIONS_PER_BEAT = 4; // sixteenth-note resolution

export interface ScoreEvent {
  /** Divisions from the start of its measure. */
  start: number;
  duration: number;
  /** Empty for a rest. */
  pitches: number[];
  tiedFrom: boolean;
  tiedTo: boolean;
}

export interface Measure {
  index: number;
  events: ScoreEvent[];
}

export type Clef = "treble" | "bass" | "percussion";

export interface Part {
  id: string;
  name: string;
  clef: Clef;
  measures: Measure[];
  beatsPerBar: number;
  /** Beat unit denominator, e.g. 4 for x/4. */
  beatUnit: number;
  divisions: number;
  /** Circle-of-fifths count for the key signature: -7..7. */
  fifths: number;
  /**
   * Semitones the notation sits above the sounding pitch.
   *
   * A bass guitar sounds an octave below where it is written — an E1 written at concert
   * pitch needs four ledger lines under the bass clef and is unreadable. Real bass parts
   * use an 8vb clef, and so does this.
   */
  octaveShift: number;
  mode: "major" | "minor";
  isDrum: boolean;
}

/** Note values available to us, largest first, in divisions (with dotted variants). */
export function noteValues(divisionsPerBeat: number): { divs: number; type: string; dots: number }[] {
  const base: [string, number][] = [
    ["whole", 4],
    ["half", 2],
    ["quarter", 1],
    ["eighth", 0.5],
    ["16th", 0.25],
  ];
  const out: { divs: number; type: string; dots: number }[] = [];
  for (const [type, beats] of base) {
    const plain = beats * divisionsPerBeat;
    const dotted = plain * 1.5;
    if (Number.isInteger(dotted)) out.push({ divs: dotted, type, dots: 1 });
    if (Number.isInteger(plain)) out.push({ divs: plain, type, dots: 0 });
  }
  return out.sort((a, b) => b.divs - a.divs);
}

/**
 * Split a duration into writable note values, tied together.
 *
 * Greedy from the largest value that fits. A duration of five sixteenths has no single
 * symbol; it is a quarter tied to a sixteenth, and pretending otherwise would silently
 * change the rhythm.
 */
export function splitDuration(divs: number, divisionsPerBeat = DIVISIONS_PER_BEAT): { divs: number; type: string; dots: number }[] {
  const values = noteValues(divisionsPerBeat);
  const out: { divs: number; type: string; dots: number }[] = [];
  let left = Math.round(divs);
  let guard = 0;
  while (left > 0 && guard++ < 64) {
    const fit = values.find((v) => v.divs <= left);
    if (!fit) break;
    out.push(fit);
    left -= fit.divs;
  }
  return out;
}

/** The key signature's position on the circle of fifths. */
export function fifthsFor(tonic: number | null, mode: string | null): number {
  if (tonic == null) return 0;
  // C=0 … B=11 as pitch classes; major keys by fifths, minors via their relative major.
  const majorFifths = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5];
  const pc = mode === "minor" ? (tonic + 3) % 12 : tonic;
  const idx = majorFifths.indexOf(pc);
  if (idx < 0) return 0;
  return idx <= 6 ? idx : idx - 12;
}

/** How far to shift the written pitch so the part sits on its staff. */
export function octaveShiftFor(notes: Note[], isDrum: boolean): number {
  if (isDrum || !notes.length) return 0;
  const lowest = Math.min(...notes.map((n) => n.pitch));
  return lowest < 40 ? 12 : 0; // below E2, write it 8vb
}

export function clefFor(notes: Note[], isDrum: boolean): Clef {
  if (isDrum) return "percussion";
  if (!notes.length) return "treble";
  const sorted = notes.map((n) => n.pitch).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return median < 60 ? "bass" : "treble";
}

/**
 * Notes -> measures.
 *
 * Everything is done in integer divisions from the start of the piece, so barlines and
 * ties are exact rather than accumulated floating point.
 */
export function buildPart(
  id: string,
  name: string,
  notes: Note[],
  grid: Grid,
  key: { tonic: number | null; mode: string | null },
  opts: { isDrum?: boolean; maxMeasures?: number } = {},
): Part {
  const per = beatsPerBar(grid);
  const dpb = DIVISIONS_PER_BEAT;
  const perMeasure = per * dpb;
  const isDrum = Boolean(opts.isDrum);

  // Seconds -> divisions, snapped.
  const placed = notes
    .map((n) => {
      const start = Math.round(secondsToBeats(grid, n.start) * dpb);
      const end = Math.round(secondsToBeats(grid, n.end) * dpb);
      return { start: Math.max(0, start), end: Math.max(start + 1, end), pitch: n.pitch };
    })
    .sort((a, b) => a.start - b.start || a.pitch - b.pitch);

  // Notes starting together become one chord.
  const chords: { start: number; end: number; pitches: number[] }[] = [];
  for (const n of placed) {
    const last = chords[chords.length - 1];
    if (last && last.start === n.start) {
      last.pitches.push(n.pitch);
      last.end = Math.max(last.end, n.end);
    } else {
      chords.push({ start: n.start, end: n.end, pitches: [n.pitch] });
    }
  }

  // A chord ends where the next one begins, at the latest: one voice per staff.
  for (let i = 0; i < chords.length; i++) {
    const next = chords[i + 1];
    if (next) chords[i].end = Math.min(chords[i].end, next.start);
    chords[i].end = Math.max(chords[i].start + 1, chords[i].end);
  }

  const lastDiv = chords.length ? chords[chords.length - 1].end : 0;
  let measureCount = Math.max(1, Math.ceil(lastDiv / perMeasure));
  if (opts.maxMeasures) measureCount = Math.min(measureCount, opts.maxMeasures);

  const measures: Measure[] = [];
  for (let m = 0; m < measureCount; m++) {
    const from = m * perMeasure;
    const to = from + perMeasure;
    const events: ScoreEvent[] = [];
    let cursor = from;

    for (const chord of chords) {
      if (chord.end <= from || chord.start >= to) continue;
      const start = Math.max(chord.start, from);
      const end = Math.min(chord.end, to);
      if (start > cursor) events.push(rest(cursor - from, start - cursor));
      events.push({
        start: start - from,
        duration: end - start,
        pitches: [...new Set(chord.pitches)].sort((a, b) => a - b),
        // A note clipped by the barline continues into the next measure.
        tiedFrom: chord.start < from,
        tiedTo: chord.end > to,
      });
      cursor = end;
    }
    if (cursor < to) events.push(rest(cursor - from, to - cursor));
    measures.push({ index: m, events });
  }

  return {
    id,
    name,
    clef: clefFor(notes, isDrum),
    measures,
    beatsPerBar: per,
    beatUnit: Number(grid.time_signature?.split("/")[1]) || 4,
    divisions: dpb,
    fifths: isDrum ? 0 : fifthsFor(key.tonic, key.mode),
    octaveShift: octaveShiftFor(notes, isDrum),
    mode: key.mode === "minor" ? "minor" : "major",
    isDrum,
  };
}

function rest(start: number, duration: number): ScoreEvent {
  return { start, duration, pitches: [], tiedFrom: false, tiedTo: false };
}

/* ------------------------------------------------------------------ tablature */

export interface Tuning {
  name: string;
  /** Open-string pitches, lowest string first. */
  strings: number[];
}

export const TUNINGS: Record<string, Tuning> = {
  bass: { name: "Bass (E A D G)", strings: [28, 33, 38, 43] },
  guitar: { name: "Guitar (E A D G B E)", strings: [40, 45, 50, 55, 59, 64] },
};

export interface TabPosition {
  /** 1 = the highest-pitched string, as tablature numbers them. */
  string: number;
  fret: number;
}

/**
 * Where to play a pitch.
 *
 * Picks the position with the lowest fret that is still on the instrument, which keeps a
 * part in first position rather than scattering it up the neck.
 */
export function tabPosition(pitch: number, tuning: Tuning, maxFret = 20): TabPosition | null {
  let best: TabPosition | null = null;
  for (let i = 0; i < tuning.strings.length; i++) {
    const fret = pitch - tuning.strings[i];
    if (fret < 0 || fret > maxFret) continue;
    const stringNumber = tuning.strings.length - i; // tab counts from the top string
    if (!best || fret < best.fret) best = { string: stringNumber, fret };
  }
  return best;
}

/** Is this part playable as tablature at all? */
export function tuningFor(notes: Note[]): Tuning | null {
  if (!notes.length) return null;
  const pitches = notes.map((n) => n.pitch);
  const lo = Math.min(...pitches);
  const hi = Math.max(...pitches);
  for (const t of [TUNINGS.bass, TUNINGS.guitar]) {
    const top = t.strings[t.strings.length - 1] + 20;
    if (lo >= t.strings[0] && hi <= top) return t;
  }
  return null;
}
