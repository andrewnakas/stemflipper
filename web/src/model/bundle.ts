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

/** project.exports keys are file names, not labels. */
const EXPORT_LABELS: Record<string, { label: string; hint?: string }> = {
  dawproject: { label: "DAW project", hint: "Bitwig, Studio One, Cubase" },
  readme: { label: "What is in this bundle", hint: "plain text" },
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
    const known = EXPORT_LABELS[key];
    other.push({ rel, label: known?.label ?? key, filename: basename(rel), hint: known?.hint });
  }

  return [
    { id: "stems", title: "Stems", blurb: "The separated audio, 24-bit FLAC.", files: stems },
    { id: "midi", title: "MIDI", blurb: "With a real tempo map and drums on channel 10.", files: midi },
    { id: "instruments", title: "Instruments", blurb: "Built from this song's own audio.", files: instruments },
    { id: "loops", title: "Loops", blurb: "Cut at real downbeats, named with tempo and key.", files: loops },
    { id: "phrases", title: "Phrases", blurb: "Vocal chops bounded by silence.", files: phrases },
    {
      id: "project",
      title: "Project",
      // The blurb has to follow what is actually here: a bundle whose DAW project was
      // trimmed out still had a "Project" group promising the whole arrangement, and
      // delivering a README.
      blurb: other.some((f) => f.rel.endsWith(".dawproject"))
        ? "Open the whole arrangement in a DAW."
        : "Notes that came with the bundle.",
      files: other,
    },
  ].filter((g) => g.files.length > 0) as BundleGroup[];
}

/**
 * Every path the bundle references, including the samples named inside the instrument
 * files rather than in project.json. Needed to zip "everything" without the server.
 */
export async function allBundlePaths(
  project: Project,
  readJson: (rel: string) => Promise<unknown>,
): Promise<string[]> {
  const paths = new Set<string>();
  const instruments: string[] = [];

  for (const g of bundleGroups(project)) {
    for (const f of g.files) {
      paths.add(f.rel);
      if (g.id === "instruments" && f.rel.endsWith(".json")) instruments.push(f.rel);
    }
  }

  for (const rel of instruments) {
    try {
      const inst = (await readJson(rel)) as {
        zones?: { path?: string }[];
        pieces?: Record<string, { zones?: { path?: string }[] }>;
      };
      const zones = inst.zones || Object.values(inst.pieces || {}).flatMap((p) => p.zones || []);
      // Zone paths are spelled from the BUNDLE root, not relative to the instrument file.
      for (const z of zones) if (z.path) paths.add(z.path.replace(/^\/+/, ""));
    } catch {
      // A missing instrument file means fewer samples in the zip, not a failed download.
    }
  }
  return [...paths];
}

function formatClock(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}
