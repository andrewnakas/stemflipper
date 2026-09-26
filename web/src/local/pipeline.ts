/**
 * The whole job, on the visitor's own machine.
 *
 * Decode -> separate -> transcribe -> assemble a project.json. The output is the same
 * contract the Space produces, so Listen, Studio, note editing and every export work on
 * it unchanged; only `separation.device` and `grid.source` say where it came from.
 *
 * Four stems by default now, not two: see `engines.ts` for the three engines a visitor can
 * pick between and why those three. The per-stem tables below mirror the server's, so a
 * track transcribed here lands on the same thresholds it would have on the Space.
 *
 * What still only happens on the server: samples, instruments, loops, phrases, effects and
 * the synth fit. `stages` says `samples=skipped` rather than pretending otherwise.
 */

import { encodeWav } from "../export/wav";
import type { AssetSource } from "../api/assets";
import type { NoteRow, Project, Track } from "../model/types";
import { analyseLocally } from "./analysis";
import { BP_SAMPLE_RATE, type BpNote, type BpOptions } from "./basicPitch";
import { DEFAULT_ENGINE, engineSpec, type LocalEngine } from "./engines";

export const LOCAL_SR = 44100;

export interface LocalProgress {
  phase: "decode" | "model" | "analyse" | "separate" | "transcribe" | "assemble";
  pct: number | null;
  detail: string;
}

export interface LocalResult {
  project: Project;
  source: AssetSource;
  /** Revoke the object URLs when replacing this. */
  dispose: () => void;
  backend: string;
  engine: LocalEngine;
}

/**
 * Per-stem transcription settings, mirroring the server's own table in
 * `stemflipper/transcription/basic_pitch.py:17-34`. Each instrument family wants different
 * sensitivity and a different frequency window; the bass clamp in particular kills
 * basic-pitch's favourite failure, the octave error.
 */
const TRANSCRIBE: Record<string, BpOptions & { label: string }> = {
  vocals: { label: "the vocal", minFreqHz: 60, maxFreqHz: 1500, onsetThreshold: 0.5, frameThreshold: 0.3 },
  bass: { label: "the bass", minFreqHz: 30, maxFreqHz: 350, onsetThreshold: 0.6, frameThreshold: 0.4 },
  guitar: { label: "the guitar", minFreqHz: 70, maxFreqHz: 1400, onsetThreshold: 0.5, frameThreshold: 0.3 },
  piano: { label: "the keys", minFreqHz: 27.5, maxFreqHz: 4200, onsetThreshold: 0.5, frameThreshold: 0.3 },
  other: { label: "the rest", minFreqHz: 30, maxFreqHz: 4200, onsetThreshold: 0.5, frameThreshold: 0.3 },
  instrumental: { label: "the instrumental", minFreqHz: 30, maxFreqHz: 4200, onsetThreshold: 0.5, frameThreshold: 0.3 },
};

/** Matches `stemflipper/export/project_json.py:29-36` so a browser run looks like a server one. */
const COLORS: Record<string, string> = {
  vocals: "#e0a458",
  drums: "#6ad5c0",
  bass: "#8a7fe8",
  guitar: "#e07a7a",
  piano: "#7ab8e0",
  other: "#9aa7b8",
  instrumental: "#6ad5c0",
};

/**
 * Track order, matching the server's `separate.KNOWN_STEMS` (`pipeline.py:207`). Engines
 * emit in their own order — htdemucs starts with drums, Spleeter with vocals — and without
 * this the Listen and Studio track lists would reshuffle depending on which one ran.
 */
const STEM_ORDER = ["vocals", "drums", "bass", "guitar", "piano", "other", "instrumental"];

function inServerOrder(ids: string[]): string[] {
  return [...ids].sort((a, b) => {
    const ia = STEM_ORDER.indexOf(a);
    const ib = STEM_ORDER.indexOf(b);
    return (ia < 0 ? STEM_ORDER.length : ia) - (ib < 0 ? STEM_ORDER.length : ib);
  });
}

const NAMES: Record<string, string> = {
  vocals: "Vocals",
  drums: "Drums",
  bass: "Bass",
  guitar: "Guitar",
  piano: "Keys",
  other: "Everything else",
  instrumental: "Instrumental",
};

/**
 * The server prefers a pYIN monophonic tracker for bass and clamps the result to
 * `_BASS_MIDI_RANGE` (`transcription/policy.py:122-132`). There is no pYIN here, so bass
 * goes through basic-pitch with the server's bass thresholds and only the octave clamp is
 * ported. Notes below the range are lifted an octave at a time rather than dropped.
 */
const BASS_LO = 24;
const BASS_HI = 60;
function fixBassOctaves(notes: BpNote[]): BpNote[] {
  return notes.map((n) => {
    let p = n.pitch;
    while (p < BASS_LO) p += 12;
    while (p > BASS_HI) p -= 12;
    return p === n.pitch ? n : { ...n, pitch: p };
  });
}

function ctxFor(channels: number, length: number, rate: number): OfflineAudioContext {
  const Ctor: typeof OfflineAudioContext =
    (window as any).OfflineAudioContext || (window as any).webkitOfflineAudioContext;
  return new Ctor(channels, Math.max(1, Math.ceil(length)), rate);
}

/** Resample (and optionally downmix) through an OfflineAudioContext. */
export async function resample(buffer: AudioBuffer, rate: number, channels = buffer.numberOfChannels): Promise<AudioBuffer> {
  if (buffer.sampleRate === rate && buffer.numberOfChannels === channels) return buffer;
  const ctx = ctxFor(channels, (buffer.duration * rate) | 0, rate);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
  return ctx.startRendering();
}

function bufferFrom(channels: Float32Array[], rate: number): AudioBuffer {
  const ctx = ctxFor(channels.length, channels[0].length, rate);
  const buf = ctx.createBuffer(channels.length, channels[0].length, rate);
  // A fresh Float32Array: the worker's transferred buffers are typed ArrayBufferLike,
  // which copyToChannel does not accept.
  for (let c = 0; c < channels.length; c++) buf.copyToChannel(new Float32Array(channels[c]), c);
  return buf;
}

function rowsFrom(notes: BpNote[]): NoteRow[] {
  return notes.map((n) => [
    n.pitch,
    Number(n.start.toFixed(4)),
    Number(n.end.toFixed(4)),
    Math.max(1, Math.min(127, Math.round(n.amplitude * 127))),
    Number(Math.min(1, n.amplitude).toFixed(3)),
  ]);
}

function peakDb(chs: Float32Array[]): number {
  let peak = 0;
  for (const ch of chs) for (let i = 0; i < ch.length; i += 16) peak = Math.max(peak, Math.abs(ch[i]));
  return peak > 0 ? Number((20 * Math.log10(peak)).toFixed(1)) : -120;
}

/**
 * Talk to the worker, resolving on its first non-status reply.
 *
 * Rejects the moment the signal aborts rather than at the next stage boundary. Without
 * that, cancelling during a four-minute separation showed "Cancelled" immediately while
 * the worker kept the GPU busy to the end of the job.
 */
function ask<T>(
  worker: Worker,
  message: unknown,
  onStatus?: (m: any) => void,
  transfer: Transferable[] = [],
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.removeEventListener("message", onMessage);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const onMessage = (e: MessageEvent) => {
      const m = e.data || {};
      if (m.type === "status" || m.type === "note" || m.type === "ready") {
        onStatus?.(m);
        return;
      }
      cleanup();
      if (m.type === "error") reject(new Error(m.message || "The local engine failed."));
      else resolve(m as T);
    };
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.addEventListener("message", onMessage);
    worker.postMessage(message, transfer);
  });
}

export async function runLocally(
  file: File,
  onProgress: (p: LocalProgress) => void,
  signal?: AbortSignal,
  engine: LocalEngine = DEFAULT_ENGINE,
): Promise<LocalResult> {
  const report = (phase: LocalProgress["phase"], pct: number | null, detail: string) =>
    onProgress({ phase, pct, detail });

  report("decode", null, "Reading the file…");
  const ac = new (((window as any).AudioContext || (window as any).webkitAudioContext) as typeof AudioContext)();
  const decoded = await ac.decodeAudioData(await file.arrayBuffer());
  let mix: AudioBuffer | null = await resample(decoded, LOCAL_SR, 2);
  void ac.close();
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  report("analyse", null, "Finding the tempo and key…");
  const analysis = analyseLocally(mix);
  const durationS = mix.duration;

  const worker = new Worker(new URL("./local.worker.ts", import.meta.url));
  // Terminating is the only thing that actually stops work in flight: the worker is busy
  // inside a model run and will not see a message until the chunk finishes.
  const stop = () => worker.terminate();
  signal?.addEventListener("abort", stop, { once: true });
  let backend = "wasm";

  try {
    const left = Float32Array.from(mix.getChannelData(0));
    const right = Float32Array.from(mix.numberOfChannels > 1 ? mix.getChannelData(1) : mix.getChannelData(0));
    // The decoded mix is ~84 MB for a 4-minute track and nothing below needs it — only its
    // two channels, which have just been copied out. Four stems make this page the tightest
    // it gets, so hand the memory back before separation rather than after.
    mix = null;

    const spec = engineSpec(engine);
    const sep = await ask<{
      stems: Record<string, Float32Array[]>;
      order: string[];
      residualDb: number | null;
    }>(
      worker,
      { type: "separate", engine, left, right },
      (m) => {
        if (m.type === "ready") backend = m.backend;
        if (m.type === "status") {
          report(m.phase === "separate" ? "separate" : "model", m.pct ?? null, m.detail);
        }
      },
      [left.buffer, right.buffer],
      signal,
    );
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const stems = sep.stems;
    const ids = inServerOrder(sep.order?.length ? sep.order : Object.keys(stems));
    const urls: Record<string, string> = {};
    const tracks: Track[] = [];

    for (const id of ids) {
      report("assemble", null, `Writing ${NAMES[id] ?? id}…`);
      const buf = bufferFrom(stems[id], LOCAL_SR);
      urls[`stems/${id}.wav`] = URL.createObjectURL(encodeWav(buf, 16));

      const mono = await resample(buf, BP_SAMPLE_RATE, 1);
      const isDrums = id === "drums";
      const opts = TRANSCRIBE[id] ?? TRANSCRIBE.other;
      const { notes } = await ask<{ notes: BpNote[] }>(
        worker,
        isDrums
          ? {
              type: "drums",
              mono: Float32Array.from(mono.getChannelData(0)),
              sampleRate: BP_SAMPLE_RATE,
              label: "the drums",
            }
          : {
              type: "transcribe",
              mono: Float32Array.from(mono.getChannelData(0)),
              opts,
              label: opts.label,
            },
        (m) => m.type === "status" && report("transcribe", m.pct ?? null, m.detail),
        [],
        signal,
      );
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const finalNotes = id === "bass" ? fixBassOctaves(notes) : notes;
      const peak = peakDb(stems[id]);
      // Done with this stem's samples: the WAV blob is what plays from here on. Holding all
      // four stereo buffers to the end costs ~340 MB on a 4-minute track for nothing.
      stems[id] = [];
      tracks.push({
        id,
        name: NAMES[id] ?? id,
        role: id,
        kind: isDrums ? "drums" : "pitched",
        color: COLORS[id] ?? "#9aa7b8",
        audio: {
          src: `stems/${id}.wav`,
          silent: finalNotes.length === 0 && peak < -60,
          peak_db: peak,
          lufs: null,
        },
        sub_stems: [],
        character: {},
        transcription: {
          engine: isDrums ? "drums_onset (browser)" : "basic_pitch (browser)",
          fallback: isDrums
            ? "onsets from the RMS flux, not the server's librosa detector; the kit is not split"
            : id === "bass"
              ? "basic_pitch with the octave clamp; no monophonic pitch tracker in the browser"
              : null,
          n_notes: finalNotes.length,
          quantized: false,
          subdivision: 4,
        },
        notes: rowsFrom(finalNotes),
        f0: null,
        instrument: { sampler: null, sfz: null, dspreset: null, patch: null, vital: null },
        effects: null,
        loops: [],
        phrases: [],
        midi: null,
      });
    }

    const project: Project = {
      schema_version: 2,
      app: { name: "stemflipper", version: "3.0.0-browser", created_utc: new Date().toISOString() },
      song: { source_file: file.name, duration: durationS, sample_rate: LOCAL_SR, channels: 2 },
      grid: analysis.grid,
      key: analysis.key,
      chords: [],
      sections: [],
      separation: {
        preset: "browser",
        device: backend,
        gpu_seconds: 0,
        ...(sep.residualDb !== null && sep.residualDb !== undefined
          ? { residual_db: sep.residualDb }
          : {}),
        chain: [{ step: "stems", model: spec.modelName, input: "mix", seconds: 0 }],
      },
      tracks,
      midi: { song: null, chords: null },
      exports: {},
      stages: [
        {
          name: "separate",
          status: "ok",
          seconds: 0,
          detail:
            `${spec.stems.length} stems on ${backend}, in your browser` +
            (sep.residualDb !== null && sep.residualDb !== undefined
              ? ` (residual ${sep.residualDb} dB)`
              : ""),
        },
        { name: "beats", status: "fallback", seconds: 0, detail: `tempo from onset autocorrelation (confidence ${analysis.tempoConfidence.toFixed(2)}); no beat tracker in the browser` },
        { name: "transcribe", status: "ok", seconds: 0, detail: "basic-pitch, in your browser" },
        { name: "samples", status: "skipped", seconds: 0, detail: "sample and instrument building runs on the server only" },
      ],
    };

    return {
      project,
      source: { kind: "blob", urls },
      dispose: () => {
        for (const u of Object.values(urls)) URL.revokeObjectURL(u);
      },
      backend,
      engine,
    };
  } finally {
    signal?.removeEventListener("abort", stop);
    worker.terminate();
  }
}
