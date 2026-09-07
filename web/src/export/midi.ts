/** Standard MIDI File writer (format 1) for the edited notes.
 *
 * Carries the project's tempo map and time signature so an exported file lands on the
 * grid in a DAW, including on songs whose tempo drifts.
 */

import { secondsToBeats } from "../model/grid";
import type { Grid, Note } from "../model/types";

const TPQ = 480;
const DRUM_CHANNEL = 9;

const PROGRAMS: Record<string, number> = {
  vocals: 53, bass: 33, guitar: 24, piano: 0, other: 48,
};

function varLen(value: number): number[] {
  let v = Math.max(0, Math.floor(value));
  const out = [v & 0x7f];
  v >>= 7;
  while (v > 0) {
    out.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return out;
}

function chunk(id: string, data: number[]): number[] {
  const len = data.length;
  return [
    ...[...id].map((c) => c.charCodeAt(0)),
    (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff,
    ...data,
  ];
}

interface Ev {
  tick: number;
  order: number;
  bytes: number[];
}

function serialize(events: Ev[]): number[] {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const out: number[] = [];
  let last = 0;
  for (const e of events) {
    out.push(...varLen(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  out.push(...varLen(0), 0xff, 0x2f, 0x00); // end of track
  return out;
}

function tickOf(grid: Grid | null, seconds: number): number {
  return Math.max(0, Math.round(secondsToBeats(grid, seconds) * TPQ));
}

function tempoTrack(grid: Grid | null, sections: { start: number; label: string }[]): number[] {
  const events: Ev[] = [];
  const [num, den] = (grid?.time_signature || "4/4").split("/").map((n) => parseInt(n, 10) || 4);
  const denPow = Math.round(Math.log2(den || 4));
  events.push({ tick: 0, order: 0, bytes: [0xff, 0x58, 0x04, num, denPow, 24, 8] });

  const map = grid?.tempo_map?.length ? grid.tempo_map : [[0, grid?.tempo || 120] as [number, number]];
  for (const [seconds, bpm] of map) {
    const usPerBeat = Math.round(60_000_000 / Math.max(1, bpm));
    events.push({
      tick: tickOf(grid, seconds),
      order: 1,
      bytes: [0xff, 0x51, 0x03, (usPerBeat >> 16) & 0xff, (usPerBeat >> 8) & 0xff, usPerBeat & 0xff],
    });
  }
  for (const s of sections || []) {
    const text = [...s.label].map((c) => c.charCodeAt(0) & 0x7f);
    events.push({ tick: tickOf(grid, s.start), order: 2, bytes: [0xff, 0x06, text.length, ...text] });
  }
  return serialize(events);
}

function noteTrack(name: string, notes: Note[], grid: Grid | null, isDrum: boolean): number[] {
  const events: Ev[] = [];
  const label = [...name].map((c) => c.charCodeAt(0) & 0x7f);
  events.push({ tick: 0, order: 0, bytes: [0xff, 0x03, label.length, ...label] });
  const channel = isDrum ? DRUM_CHANNEL : 0;
  if (!isDrum) {
    events.push({ tick: 0, order: 1, bytes: [0xc0 | channel, PROGRAMS[name] ?? 0] });
  }
  for (const n of notes) {
    const start = tickOf(grid, n.start);
    const end = Math.max(start + 1, tickOf(grid, n.end));
    const pitch = Math.max(0, Math.min(127, Math.round(n.pitch)));
    const vel = Math.max(1, Math.min(127, Math.round(n.vel)));
    events.push({ tick: start, order: 3, bytes: [0x90 | channel, pitch, vel] });
    events.push({ tick: end, order: 2, bytes: [0x80 | channel, pitch, 0] });
  }
  return serialize(events);
}

export interface MidiTrackInput {
  name: string;
  notes: Note[];
  isDrum: boolean;
}

export function writeMidi(
  tracks: MidiTrackInput[],
  grid: Grid | null,
  sections: { start: number; label: string }[] = [],
): Uint8Array {
  const withNotes = tracks.filter((t) => t.notes.length);
  const header = chunk("MThd", [0, 1, 0, withNotes.length + 1, (TPQ >> 8) & 0xff, TPQ & 0xff]);
  const body = [chunk("MTrk", tempoTrack(grid, sections))];
  for (const t of withNotes) body.push(chunk("MTrk", noteTrack(t.name, t.notes, grid, t.isDrum)));
  return new Uint8Array([...header, ...body.flat()]);
}
