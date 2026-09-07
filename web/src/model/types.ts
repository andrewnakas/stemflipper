/** The project.json contract (schema_version 2), as the browser sees it. */

export type StageStatus = "ok" | "fallback" | "skipped" | "failed";
export type TrackKind = "pitched" | "drums";
export type LaneId = "original" | "synth" | "sampler";

/** [pitch, start_s, end_s, velocity, confidence] */
export type NoteRow = [number, number, number, number, number];

export interface Note {
  id: string;
  pitch: number;
  start: number;
  end: number;
  vel: number;
  conf: number;
}

export interface Grid {
  tempo: number;
  time_signature: string;
  beats: number[];
  downbeats: number[];
  tempo_map: [number, number][];
  source: string;
}

export interface SubStem {
  id: string;
  src: string;
  gm: number[];
}

export interface EqBand {
  type: string;
  freq: number;
  gain_db: number;
  q: number;
}

export interface TrackEffects {
  eq: { bands: EqBand[]; match_bands: EqBand[] | null } | null;
  reverb: { rt60_s: number; wet: boolean; ir: string | null; mix: number } | null;
}

export interface InstrumentRefs {
  sampler: string | null;
  sfz: string | null;
  dspreset: string | null;
  patch: string | null;
  vital: string | null;
}

export interface LoopRef {
  src: string;
  start: number;
  bars: number;
  bpm: number;
}

export interface PhraseRef {
  src: string;
  start: number;
  end: number;
  lo: number;
  hi: number;
}

export interface Track {
  id: string;
  name: string;
  role: string;
  kind: TrackKind;
  color: string;
  audio: { src: string | null; silent: boolean; peak_db: number | null; lufs: number | null };
  sub_stems: SubStem[];
  character: Record<string, unknown>;
  transcription: { engine: string; fallback: string | null; n_notes: number; quantized: boolean; subdivision: number };
  notes: NoteRow[];
  f0: { src?: string; hop_s: number } | null;
  instrument: InstrumentRefs;
  effects: TrackEffects | null;
  loops: LoopRef[];
  phrases: PhraseRef[];
  midi: string | null;
}

export interface Stage {
  name: string;
  status: StageStatus;
  seconds: number;
  detail: string;
}

export interface Project {
  schema_version: number;
  app: { name: string; version: string; created_utc: string };
  song: { source_file: string; duration: number; sample_rate: number; channels: number };
  grid: Grid;
  key: { name: string; tonic: number | null; mode: string | null; confidence: number };
  chords: { start: number; end: number; label: string; root: number | null; quality: string | null; conf: number }[];
  sections: { start: number; end: number; label: string }[];
  separation: { preset: string; device: string; gpu_seconds: number; residual_db?: number; chain: { step: string; model: string; input: string; seconds: number }[] };
  tracks: Track[];
  midi: { song: string | null; chords: string | null };
  exports: Record<string, string | null>;
  stages: Stage[];
  _server?: { bundle_root: string };
}

/** Sampler instrument.json / kit.json (fetched separately; these keep the key "path"). */
export interface SampleZone {
  path: string;
  root?: number;
  lo?: number;
  hi?: number;
  lovel: number;
  hivel: number;
  rr: number;
  gain_db?: number;
  loop?: { start: number; end: number; crossfade: number } | null;
}

export interface Multisample {
  type: "multisample";
  name: string;
  amp_env: { a: number; d: number; s: number; r: number };
  zones: SampleZone[];
}

export interface DrumKit {
  type: "drumkit";
  name: string;
  pieces: Record<string, { gm: number; gm_all: number[]; zones: SampleZone[] }>;
}

export type Instrument = Multisample | DrumKit;

/** A synth patch (patch.json) the browser renders with oscillators + filter. */
export interface Patch {
  type: string;
  mono: boolean;
  gain: number;
  glide_s: number;
  oscillators: { wave: OscWave; level: number; detune_cents: number; octave: number }[];
  unison: { voices: number; detune_cents: number };
  filter: { type: BiquadFilterType; cutoff_hz: number; q: number; env_amount_hz: number; key_track: number };
  filter_env: { a: number; d: number; s: number; r: number };
  amp_env: { a: number; d: number; s: number; r: number };
}

export type OscWave = "saw" | "square" | "triangle" | "sine" | "noise";

export function notesFromRows(trackId: string, rows: NoteRow[]): Note[] {
  return rows.map((r, i) => ({
    id: `${trackId}:${i}`,
    pitch: r[0],
    start: r[1],
    end: r[2],
    vel: r[3],
    conf: r.length > 4 ? r[4] : 0.7,
  }));
}

export function rowsFromNotes(notes: Note[]): NoteRow[] {
  return notes
    .slice()
    .sort((a, b) => a.start - b.start || a.pitch - b.pitch)
    .map((n) => [n.pitch, +n.start.toFixed(4), +n.end.toFixed(4), n.vel, +n.conf.toFixed(3)] as NoteRow);
}
