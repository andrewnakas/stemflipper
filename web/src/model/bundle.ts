/**
 * What a finished bundle actually contains.
 *
 * v2 produced SFZ, DecentSampler and Vital instruments, bar-aligned loops, vocal phrase
 * chops and a DAWproject on every run, and the web app showed none of them — it read only
 * the project JSON and dropped the zip on the floor. This enumerates everything the
 * project references so the Listen screen can offer it.
 *
 * Pure, so it is testable and works the same for a server bundle, a static fixture and a
 * zip opened in the browser.
 */

import type { Project } from "./types";

export interface BundleFile {
  /** Bundle-relative path, as project.json spells it. */
  rel: string;
  /** What to call it in the list. */
  label: string;
  /** What to name the downloaded file. */
  filename: string;
  hint?: string;
}

export interface BundleGroup {
  id: "stems" | "midi" | "instruments" | "loops" | "phrases" | "project";
  title: string;
  blurb: string;
  files: BundleFile[];
}

function basename(path: string): string {
  return path.split("/").pop() || path;
}

const INSTRUMENT_HINTS: Record<string, string> = {
  sfz: "sfizz, Sforzando",
  dspreset: "DecentSampler (free)",
  vital: "Vital",
  sampler: "used by the editor",
};

export function bundleGroups(project: Project): BundleGroup[] {
  const stems: BundleFile[] = [];
  const midi: BundleFile[] = [];
  const instruments: BundleFile[] = [];
  const loops: BundleFile[] = [];
  const phrases: BundleFile[] = [];
  const other: BundleFile[] = [];

  for (const t of project.tracks) {
    if (t.audio.src && !t.audio.silent) {
      stems.push({ rel: t.audio.src, label: t.name, filename: basename(t.audio.src) });
    }
    for (const sub of t.sub_stems || []) {
      if (sub.src) {
        stems.push({ rel: sub.src, label: `${t.name} · ${sub.id}`, filename: basename(sub.src), hint: "kit piece" });
      }
    }
    if (t.midi) midi.push({ rel: t.midi, label: t.name, filename: basename(t.midi) });

    for (const kind of ["sampler", "sfz", "dspreset", "vital"] as const) {
      const rel = t.instrument?.[kind];
      if (rel) {
        instruments.push({
          rel,
          label: `${t.name} · ${kind === "sampler" ? "sample map" : kind}`,
          filename: basename(rel),
          hint: INSTRUMENT_HINTS[kind],
        });
      }
    }
    for (const l of t.loops || []) {
      loops.push({
        rel: l.src,
        label: `${t.name} · ${l.bars} bar${l.bars === 1 ? "" : "s"}`,
        filename: basename(l.src),
        hint: `${Math.round(l.bpm)} BPM`,
      });
    }
    for (const p of t.phrases || []) {
      phrases.push({ rel: p.src, label: `${t.name} · ${formatClock(p.start)}`, filename: basename(p.src) });
    }
  }

  if (project.midi?.song) midi.unshift({ rel: project.midi.song, label: "Everything (multitrack)", filename: basename(project.midi.song) });
  if (project.midi?.chords) midi.push({ rel: project.midi.chords, label: "Chords", filename: basename(project.midi.chords) });

  for (const [key, rel] of Object.entries(project.exports || {})) {
    if (!rel) continue;
    other.push({
      rel,
      label: key === "dawproject" ? "DAW project" : key,
      filename: basename(rel),
      hint: key === "dawproject" ? "Bitwig, Studio One, Cubase" : undefined,
    });
  }

  return [
    { id: "stems", title: "Stems", blurb: "The separated audio, 24-bit FLAC.", files: stems },
    { id: "midi", title: "MIDI", blurb: "With a real tempo map and drums on channel 10.", files: midi },
    { id: "instruments", title: "Instruments", blurb: "Built from this song's own audio.", files: instruments },
    { id: "loops", title: "Loops", blurb: "Cut at real downbeats, named with tempo and key.", files: loops },
    { id: "phrases", title: "Phrases", blurb: "Vocal chops bounded by silence.", files: phrases },
    { id: "project", title: "Project", blurb: "Open the whole arrangement in a DAW.", files: other },
  ].filter((g) => g.files.length > 0) as BundleGroup[];
}

export function countFiles(project: Project): number {
  return bundleGroups(project).reduce((n, g) => n + g.files.length, 0);
}

function formatClock(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}
