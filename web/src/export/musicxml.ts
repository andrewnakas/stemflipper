/**
 * MusicXML, so the transcription can leave here and be edited properly.
 *
 * This is the format every notation program reads — MuseScore, Sibelius, Dorico, Finale,
 * Guitar Pro — which makes it far more useful than a picture of a stave. Tablature parts
 * carry string and fret in <technical>, so a bass line opens as tab rather than as notes
 * somebody then has to work out positions for.
 *
 * Written by hand rather than with a library: the document is small, the shape is fixed,
 * and a dependency here would be larger than the code.
 */

import { splitDuration, tabPosition, type Part, type Tuning } from "../model/score";

const SHARP_STEPS = ["C", "C", "D", "D", "E", "F", "F", "G", "G", "A", "A", "B"];
const SHARP_ALTER = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
const FLAT_STEPS = ["C", "D", "D", "E", "E", "F", "G", "G", "A", "A", "B", "B"];
const FLAT_ALTER = [0, -1, 0, -1, 0, 0, -1, 0, -1, 0, -1, 0];

export interface Spelled {
  step: string;
  alter: number;
  octave: number;
}

/** Spell a MIDI pitch, following the key signature so F# major is not written in flats. */
export function spell(pitch: number, fifths: number): Spelled {
  const useFlats = fifths < 0;
  const pc = ((pitch % 12) + 12) % 12;
  const step = useFlats ? FLAT_STEPS[pc] : SHARP_STEPS[pc];
  const alter = useFlats ? FLAT_ALTER[pc] : SHARP_ALTER[pc];
  return { step, alter, octave: Math.floor(pitch / 12) - 1 };
}

function esc(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}

function clefXml(part: Part, tab: Tuning | null): string {
  if (tab) return `<clef><sign>TAB</sign><line>5</line></clef>`;
  if (part.clef === "percussion") return `<clef><sign>percussion</sign><line>2</line></clef>`;
  // clef-octave-change declares that what is written sounds an octave lower, which is how
  // a bass guitar part is notated everywhere.
  const shift = part.octaveShift ? `<clef-octave-change>-${part.octaveShift / 12}</clef-octave-change>` : "";
  if (part.clef === "bass") return `<clef><sign>F</sign><line>4</line>${shift}</clef>`;
  return `<clef><sign>G</sign><line>2</line>${shift}</clef>`;
}

function staffDetails(tab: Tuning): string {
  const lines = tab.strings.length;
  // MusicXML numbers strings from the top down, so the tuning is listed in reverse.
  const tunings = tab.strings
    .slice()
    .reverse()
    .map((pitch, i) => {
      const s = spell(pitch, 0);
      return (
        `<staff-tuning line="${i + 1}">` +
        `<tuning-step>${s.step}</tuning-step>` +
        (s.alter ? `<tuning-alter>${s.alter}</tuning-alter>` : "") +
        `<tuning-octave>${s.octave}</tuning-octave>` +
        `</staff-tuning>`
      );
    })
    .join("");
  return `<staff-details><staff-lines>${lines}</staff-lines>${tunings}</staff-details>`;
}

function noteXml(
  part: Part,
  pitch: number | null,
  divs: number,
  type: string,
  dots: number,
  opts: { chord?: boolean; tieStart?: boolean; tieStop?: boolean; tab?: Tuning | null },
): string {
  const bits: string[] = [];
  if (opts.chord) bits.push("<chord/>");

  if (pitch == null) {
    bits.push("<rest/>");
  } else if (part.isDrum) {
    // Unpitched percussion still needs a place on the staff to be drawn.
    const s = spell(pitch, 0);
    bits.push(`<unpitched><display-step>${s.step}</display-step><display-octave>${s.octave}</display-octave></unpitched>`);
  } else {
    // Written pitch, which the clef's octave change turns back into the sounding one.
    const s = spell(pitch + part.octaveShift, part.fifths);
    bits.push(`<pitch><step>${s.step}</step>${s.alter ? `<alter>${s.alter}</alter>` : ""}<octave>${s.octave}</octave></pitch>`);
  }

  bits.push(`<duration>${divs}</duration>`);
  if (opts.tieStop) bits.push(`<tie type="stop"/>`);
  if (opts.tieStart) bits.push(`<tie type="start"/>`);
  bits.push("<voice>1</voice>");
  bits.push(`<type>${type}</type>`);
  for (let i = 0; i < dots; i++) bits.push("<dot/>");

  const notations: string[] = [];
  if (opts.tieStop) notations.push(`<tied type="stop"/>`);
  if (opts.tieStart) notations.push(`<tied type="start"/>`);
  if (opts.tab && pitch != null) {
    const pos = tabPosition(pitch, opts.tab);
    if (pos) notations.push(`<technical><string>${pos.string}</string><fret>${pos.fret}</fret></technical>`);
  }
  if (notations.length) bits.push(`<notations>${notations.join("")}</notations>`);

  return `<note>${bits.join("")}</note>`;
}

export interface ScorePartOptions {
  part: Part;
  /** When set, this part is written as tablature. */
  tab?: Tuning | null;
}

export function toMusicXml(
  parts: ScorePartOptions[],
  opts: { title: string; tempo: number; software?: string },
): string {
  const partList = parts
    .map(
      (p, i) =>
        `<score-part id="P${i + 1}"><part-name>${esc(p.part.name + (p.tab ? " (tab)" : ""))}</part-name></score-part>`,
    )
    .join("");

  const body = parts
    .map((p, i) => {
      const { part, tab } = p;
      const measures = part.measures
        .map((m, mi) => {
          const head =
            mi === 0
              ? `<attributes>` +
                `<divisions>${part.divisions}</divisions>` +
                `<key><fifths>${part.fifths}</fifths><mode>${part.mode}</mode></key>` +
                `<time><beats>${part.beatsPerBar}</beats><beat-type>${part.beatUnit}</beat-type></time>` +
                (tab ? staffDetails(tab) : "") +
                clefXml(part, tab ?? null) +
                `</attributes>` +
                `<direction placement="above"><direction-type><metronome>` +
                `<beat-unit>quarter</beat-unit><per-minute>${Math.round(opts.tempo)}</per-minute>` +
                `</metronome></direction-type><sound tempo="${Math.round(opts.tempo)}"/></direction>`
              : "";

          const notes = m.events
            .map((ev) => {
              const pieces = splitDuration(ev.duration, part.divisions);
              return pieces
                .map((piece, pi) => {
                  const first = pi === 0;
                  const last = pi === pieces.length - 1;
                  // A note split across several symbols is tied together, and separately
                  // tied to whatever continued over the barline.
                  const tieStop = ev.pitches.length > 0 && (!first || ev.tiedFrom);
                  const tieStart = ev.pitches.length > 0 && (!last || ev.tiedTo);
                  if (!ev.pitches.length) {
                    return noteXml(part, null, piece.divs, piece.type, piece.dots, {});
                  }
                  return ev.pitches
                    .map((pitch, ci) =>
                      noteXml(part, pitch, piece.divs, piece.type, piece.dots, {
                        chord: ci > 0,
                        tieStart,
                        tieStop,
                        tab,
                      }),
                    )
                    .join("");
                })
                .join("");
            })
            .join("");

          return `<measure number="${mi + 1}">${head}${notes}</measure>`;
        })
        .join("");
      return `<part id="P${i + 1}">${measures}</part>`;
    })
    .join("");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n` +
    `<score-partwise version="4.0">` +
    `<work><work-title>${esc(opts.title)}</work-title></work>` +
    `<identification><encoding><software>${esc(opts.software || "StemFlipper")}</software>` +
    `<encoding-date>${new Date().toISOString().slice(0, 10)}</encoding-date></encoding></identification>` +
    `<part-list>${partList}</part-list>` +
    body +
    `</score-partwise>\n`
  );
}
