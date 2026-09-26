/**
 * In-browser separation and transcription — the worker.
 *
 * This file is a dispatcher now: it brings in onnxruntime, picks an engine by id, and owns
 * basic-pitch transcription. The engines live next door and each documents its own numerics:
 *
 *   spleeter.ts       4 stems, 79 MB, ~0.2x realtime   <- the default
 *   mdx.ts            2 stems, 64 MB, ~1.1x realtime   <- cleanest vocal
 *   demucsHybrid.ts   4 stems, 180 MB, ~18x realtime   <- closest to the server
 *
 * See engines.ts for why those three, and for the two htdemucs exports that cannot be used.
 */

import type * as ORT from "onnxruntime-web";
import {
  BP_FRAMES_PER_WINDOW, N_PITCHES, notesFromOutputs, unwrapWindows, windowsFor,
  type BpOptions, type Matrix,
} from "./basicPitch";
import { transcribeDrums, type DrumNote } from "./drums";
import { DEFAULT_ENGINE, type LocalEngine } from "./engines";
import { ORT_SCRIPT, ORT_WASM_BASE, fetchModel } from "./ortRuntime";
import { separateSpleeter } from "./spleeter";
import { separateMdx } from "./mdx";
import { separateHtdemucs } from "./demucsHybrid";

/**
 * basic-pitch, 230 KB of ONNX. Small enough that transcription in a browser is not the
 * hard part — the separation model is.
 */
const BP_MODEL_URL =
  "https://cdn.jsdelivr.net/gh/spotify/basic-pitch@main/basic_pitch/saved_models/icassp_2022/nmp.onnx";
const BP_INPUT = "serving_default_input_2:0";
/** The model returns [note, onset, contour], in that order. */
const BP_OUTPUTS = ["StatefulPartitionedCall:2", "StatefulPartitionedCall:1", "StatefulPartitionedCall:0"];

export const LOCAL_SR = 44100;

/**
 * onnxruntime is pulled in at runtime rather than bundled.
 *
 * Importing it as a module makes Vite follow its `new URL(...wasm, import.meta.url)` and
 * emit a 25 MB wasm into dist — for a file we then never use, because wasmPaths points at
 * the CDN anyway. importScripts keeps the build small and the runtime identical. Types
 * come from the package via `import type`, which is erased at build time.
 */
declare const ort: typeof ORT;
declare function importScripts(...urls: string[]): void;
importScripts(ORT_SCRIPT);

type Out = Record<string, unknown>;
function post(type: string, payload: Out = {}): void {
  (self as unknown as Worker).postMessage({ ...payload, type });
}
function status(phase: string, pct: number, detail: string): void {
  post("status", { phase, pct, detail });
}

/* --------------------------------------------------------------- separation */

async function separate(engine: LocalEngine, left: Float32Array, right: Float32Array) {
  const run =
    engine === "mdx2" ? separateMdx : engine === "htdemucs4" ? separateHtdemucs : separateSpleeter;
  const r = await run(left, right, status);
  post("ready", {
    engine,
    backend: r.backend,
    threads: r.threads,
    isolated: Boolean(self.crossOriginIsolated),
  });
  return r;
}

/* --------------------------------------------------------------- transcription */

let bpSession: ORT.InferenceSession | null = null;

async function ensureBasicPitch(): Promise<ORT.InferenceSession> {
  if (bpSession) return bpSession;
  ort.env.wasm.wasmPaths = ORT_WASM_BASE;
  ort.env.logLevel = "error";
  const bytes = await fetchModel(BP_MODEL_URL, "the note model (230 KB)", status);
  // CPU only: the model is tiny and the windows are sequential, so a GPU session costs
  // more to set up than it saves.
  bpSession = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"] });
  return bpSession;
}

/** mono 22.05 kHz -> notes. */
async function transcribe(mono: Float32Array, opts: BpOptions, label: string) {
  const s = await ensureBasicPitch();
  const windows = windowsFor(mono);
  const noteWins: Float32Array[] = [];
  const onsetWins: Float32Array[] = [];

  for (let i = 0; i < windows.length; i++) {
    status("transcribe", (i / windows.length) * 100, `Finding notes in ${label} — ${i + 1} of ${windows.length}`);
    const input = new ort.Tensor("float32", windows[i], [1, windows[i].length, 1]);
    const out = await s.run({ [BP_INPUT]: input });
    noteWins.push(out[BP_OUTPUTS[0]].data as Float32Array);
    onsetWins.push(out[BP_OUTPUTS[1]].data as Float32Array);
    await new Promise((r) => setTimeout(r, 0));
  }

  const frames: Matrix = unwrapWindows(noteWins, N_PITCHES, mono.length);
  const onsets: Matrix = unwrapWindows(onsetWins, N_PITCHES, mono.length);
  void BP_FRAMES_PER_WINDOW;
  return notesFromOutputs(frames, onsets, opts);
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data || {};
  try {
    if (msg.type === "transcribe") {
      const notes = await transcribe(msg.mono, msg.opts || {}, msg.label || "the track");
      (self as unknown as Worker).postMessage({ type: "notes", id: msg.id, notes });
    } else if (msg.type === "drums") {
      // Drums do not go through basic-pitch; see drums.ts.
      status("transcribe", 0, "Finding the drum hits…");
      const notes: DrumNote[] = transcribeDrums(msg.mono, msg.sampleRate || LOCAL_SR);
      (self as unknown as Worker).postMessage({ type: "notes", id: msg.id, notes });
    } else if (msg.type === "separate") {
      const engine: LocalEngine = msg.engine || DEFAULT_ENGINE;
      const r = await separate(engine, msg.left, msg.right);
      const ids = Object.keys(r.stems);
      const transfer: ArrayBufferLike[] = [];
      for (const id of ids) for (const ch of r.stems[id]) transfer.push(ch.buffer);
      (self as unknown as Worker).postMessage(
        {
          type: "done",
          sampleRate: LOCAL_SR,
          engine,
          stems: r.stems,
          order: ids,
          residualDb: (r as { residualDb?: number }).residualDb ?? null,
        },
        transfer as Transferable[],
      );
    }
  } catch (err) {
    post("error", { message: (err as Error)?.message || String(err) });
  }
};
