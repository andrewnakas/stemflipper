/**
 * Draw a Part with VexFlow.
 *
 * The quantisation and bar-filling are already done in model/score.ts; this only turns
 * those measures into staves, notes, beams and ties. Keeping the two apart means the
 * musical arithmetic is testable without a renderer, and the renderer has no opinions
 * about rhythm.
 */

import type { Measure, Part, Tuning } from "../../model/score";
import { splitDuration, tabPosition } from "../../model/score";
import { spell } from "../../export/musicxml";

/** model/score's note types, as VexFlow duration codes. */
const VF_DURATION: Record<string, string> = {
  whole: "w",
  half: "h",
  quarter: "q",
  eighth: "8",
  "16th": "16",
};

export interface RenderOptions {
  part: Part;
  tab: Tuning | null;
  /** Total width available, in CSS pixels. */
  width: number;
  measuresPerLine: number;
  firstMeasure: number;
  lastMeasure: number;
}

function keyFor(pitch: number, fifths: number): { key: string; accidental: string | null } {
  const s = spell(pitch, fifths);
  const acc = s.alter > 0 ? "#" : s.alter < 0 ? "b" : null;
  return { key: `${s.step.toLowerCase()}${acc ?? ""}/${s.octave}`, accidental: acc };
}

/**
 * Render into `host`, replacing whatever was there.
 *
 * Returns the height used, so the caller can size its container without measuring the SVG.
 */
export async function drawPart(host: HTMLDivElement, opts: RenderOptions): Promise<number> {
  const VF = await import("vexflow");
  const { Renderer, Stave, StaveNote, TabStave, TabNote, Voice, Formatter, Beam, Dot, Accidental, StaveTie } = VF;

  host.innerHTML = "";
  const { part, tab } = opts;
  const measures = part.measures.slice(opts.firstMeasure, opts.lastMeasure);
  if (!measures.length) return 0;

  const perLine = Math.max(1, opts.measuresPerLine);
  const lines = Math.ceil(measures.length / perLine);
  const staffGap = tab ? 150 : 110;
  const height = lines * staffGap + 40;

  const renderer = new Renderer(host, Renderer.Backends.SVG);
  renderer.resize(opts.width, height);
  const ctx = renderer.getContext();

  const LEFT = 8;
  const usable = opts.width - LEFT * 2;
  // A clef and time signature take room, and only the first bar of each line carries them.
  const HEAD_W = 46;

  for (let line = 0; line < lines; line++) {
    const slice = measures.slice(line * perLine, line * perLine + perLine);
    const y = line * staffGap + 10;
    // Every LINE opens with a clef, not just the first bar of the piece — a stave with no
    // clef is not readable music.
    const barWidth = (usable - HEAD_W) / slice.length;

    let x = LEFT;
    slice.forEach((measure, i) => {
      const opensLine = i === 0;
      const width = barWidth + (opensLine ? HEAD_W : 0);

      const stave = new Stave(x, y, width);
      if (opensLine) {
        stave.addClef(
          part.clef === "percussion" ? "percussion" : part.clef,
          undefined,
          part.octaveShift ? "8vb" : undefined,
        );
        stave.addTimeSignature(`${part.beatsPerBar}/${part.beatUnit}`);
      }
      stave.setContext(ctx).draw();

      const { notes, ties } = buildNotes(measure, part, null, VF);
      if (notes.length) {
        // FormatAndDraw does the spacing and the beam grouping itself. Generating beams by
        // hand over a bar that contains rests produced beams running clean across the bar.
        Formatter.FormatAndDraw(ctx, stave, notes, { autoBeam: true, alignRests: true });
        ties.forEach((t) => t.setContext(ctx).draw());
      }

      if (tab) {
        const tabStave = new TabStave(x, y + 70, width);
        tabStave.setNumLines(tab.strings.length);
        if (opensLine) tabStave.addClef("tab");
        tabStave.setContext(ctx).draw();
        const tabNotes = buildTabNotes(measure, tab, VF);
        if (tabNotes.length) Formatter.FormatAndDraw(ctx, tabStave, tabNotes, { autoBeam: false });
      }
      x += width;
    });
  }
  void StaveNote;
  void TabNote;
  void Dot;
  void Accidental;
  void StaveTie;
  void Voice;
  void Beam;
  return height;
}

function buildNotes(measure: Measure, part: Part, _unused: null, VF: typeof import("vexflow")) {
  const { StaveNote, Dot, Accidental, StaveTie } = VF;
  const notes: InstanceType<typeof StaveNote>[] = [];
  const ties: InstanceType<typeof StaveTie>[] = [];

  for (const ev of measure.events) {
    const pieces = splitDuration(ev.duration, part.divisions);
    let previous: InstanceType<typeof StaveNote> | null = null;

    pieces.forEach((piece, pi) => {
      const base = VF_DURATION[piece.type] || "q";
      const rest = ev.pitches.length === 0;
      const keys = rest
        ? [part.clef === "bass" ? "d/3" : "b/4"]
        : ev.pitches.map((p) => keyFor(p + part.octaveShift, part.fifths).key);

      const note = new StaveNote({ keys, duration: rest ? `${base}r` : base, clef: part.clef === "percussion" ? "percussion" : part.clef });
      for (let d = 0; d < piece.dots; d++) Dot.buildAndAttach([note], { all: true });
      if (!rest) {
        ev.pitches.forEach((p, idx) => {
          const { accidental } = keyFor(p + part.octaveShift, part.fifths);
          if (accidental) note.addModifier(new Accidental(accidental), idx);
        });
      }
      notes.push(note);

      // Tie the pieces of one event together; the caller's tiedTo/tiedFrom handle bars.
      if (previous && !rest) ties.push(new StaveTie({ firstNote: previous, lastNote: note }));
      previous = rest ? null : note;
      void pi;
    });
  }
  return { notes, ties };
}

function buildTabNotes(measure: Measure, tuning: Tuning, VF: typeof import("vexflow")) {
  const { TabNote, Dot } = VF;
  const out: InstanceType<typeof TabNote>[] = [];
  for (const ev of measure.events) {
    for (const piece of splitDuration(ev.duration, 4)) {
      const base = VF_DURATION[piece.type] || "q";
      if (!ev.pitches.length) {
        out.push(new TabNote({ positions: [{ str: 1, fret: "" }], duration: `${base}r` }));
        continue;
      }
      const positions = ev.pitches
        .map((p) => tabPosition(p, tuning))
        .filter((p): p is NonNullable<typeof p> => Boolean(p))
        .map((p) => ({ str: p.string, fret: String(p.fret) }));
      if (!positions.length) {
        out.push(new TabNote({ positions: [{ str: 1, fret: "" }], duration: `${base}r` }));
        continue;
      }
      const note = new TabNote({ positions, duration: base });
      for (let d = 0; d < piece.dots; d++) Dot.buildAndAttach([note], { all: true });
      out.push(note);
    }
  }
  return out;
}
