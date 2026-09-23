/**
 * The whole job, on the visitor's own machine.
 *
 * Decode -> separate -> transcribe -> assemble a project.json. The output is the same
 * contract the Space produces, so Listen, Studio, note editing and every export work on
 * it unchanged; only `separation.device` and `grid.source` say where it came from.
 *
 * Two stems rather than four: the four-stem models that would fit in a browser do not
 * exist yet (Demucs' ONNX export is 158 MB and onnxruntime-web cannot load it). What this
 * does give is unlimited, private, account-free runs, which the shared GPU pool cannot.
 */

import { encodeWav } from "../export/wav";
import type { AssetSource } from "../api/assets";
import type { NoteRow, Project, Track } from "../model/types";
import { analyseLocally } from "./analysis";
import { BP_SAMPLE_RATE, type BpNote, type BpOptions } from "./basicPitch";

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
}

/** Per-stem transcription settings, mirroring the server's per-stem threshold table. */
const TRANSCRIBE: Record<string, BpOptions & { label: string }> = {
  vocals: { label: "the vocal", minFreqHz: 60, maxFreqHz: 1500, onsetThreshold: 0.5, frameThreshold: 0.3 },
  instrumental: { label: "the instrumental", minFreqHz: 30, maxFreqHz: 4200, onsetThreshold: 0.5, frameThreshold: 0.3 },
};

const COLORS: Record<string, string> = { vocals: "#e0a458", instrumental: "#6ad5c0" };

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
): Promise<LocalResult> {
  const report = (phase: LocalProgress["phase"], pct: number | null, detail: string) =>
    onProgress({ phase, pct, detail });

  report("decode", null, "Reading the file…");
  const ac = new (((window as any).AudioContext || (window as any).webkitAudioContext) as typeof AudioContext)();
  const decoded = await ac.decodeAudioData(await file.arrayBuffer());
  const mix = await resample(decoded, LOCAL_SR, 2);
  void ac.close();
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  report("analyse", null, "Finding the tempo and key…");
  const analysis = analyseLocally(mix);

  const worker = new Worker(new URL("./local.worker.ts", import.meta.url));
  // Terminating is the only thing that actually stops work in flight: the worker is busy
  // inside a model run and will not see a message until the chunk finishes.
  const stop = () => worker.terminate();
  signal?.addEventListener("abort", stop, { once: true });
  let backend = "wasm";

  try {
    const left = Float32Array.from(mix.getChannelData(0));
    const right = Float32Array.from(mix.numberOfChannels > 1 ? mix.getChannelData(1) : mix.getChannelData(0));

    const sep = await ask<{ vocals: Float32Array[]; instrumental: Float32Array[] }>(
      worker,
      { type: "separate", left, right },
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

    const stems: Record<string, Float32Array[]> = { vocals: sep.vocals, instrumental: sep.instrumental };
    const urls: Record<string, string> = {};
    const tracks: Track[] = [];

    for (const id of ["vocals", "instrumental"] as const) {
      report("assemble", null, `Writing ${id}…`);
      const buf = bufferFrom(stems[id], LOCAL_SR);
      urls[`stems/${id}.wav`] = URL.createObjectURL(encodeWav(buf, 16));

      const mono = await resample(buf, BP_SAMPLE_RATE, 1);
      const opts = TRANSCRIBE[id];
      const { notes } = await ask<{ notes: BpNote[] }>(
        worker,
        { type: "transcribe", mono: Float32Array.from(mono.getChannelData(0)), opts, label: opts.label },
        (m) => m.type === "status" && report("transcribe", m.pct ?? null, m.detail),
        [],
        signal,
      );
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      tracks.push({
        id,
        name: id === "vocals" ? "Vocals" : "Instrumental",
        role: id,
        kind: "pitched",
        color: COLORS[id],
        audio: { src: `stems/${id}.wav`, silent: notes.length === 0 && peakDb(stems[id]) < -60, peak_db: peakDb(stems[id]), lufs: null },
        sub_stems: [],
        character: {},
        transcription: {
          engine: "basic_pitch (browser)",
          fallback: null,
          n_notes: notes.length,
          quantized: false,
          subdivision: 4,
        },
        notes: rowsFrom(notes),
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
      song: { source_file: file.name, duration: mix.duration, sample_rate: LOCAL_SR, channels: 2 },
      grid: analysis.grid,
      key: analysis.key,
      chords: [],
      sections: [],
      separation: {
        preset: "browser",
        device: backend,
        gpu_seconds: 0,
        chain: [{ step: "vocals", model: "UVR-MDX-NET-Voc_FT", input: "mix", seconds: 0 }],
      },
      tracks,
      midi: { song: null, chords: null },
      exports: {},
      stages: [
        { name: "separate", status: "ok", seconds: 0, detail: `UVR-MDX-NET on ${backend}, in your browser` },
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
    };
  } finally {
    signal?.removeEventListener("abort", stop);
    worker.terminate();
  }
}
