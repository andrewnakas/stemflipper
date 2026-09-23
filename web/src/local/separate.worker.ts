/**
 * In-browser source separation.
 *
 * Runs UVR-MDX-NET through onnxruntime-web to pull the vocal out of a mix; the
 * instrumental is the residual, which keeps the two exactly complementary. Ported from
 * audiosaw.com's js/stem-worker.js, where this has been in production — same algorithm,
 * typed, and loading its runtime from a CDN instead of a vendored copy.
 *
 * Why this model and not Demucs: Demucs is the better-known name, but its ONNX export is
 * 158 MB and onnxruntime-web cannot load it — session creation runs for two minutes and
 * then aborts inside the WASM heap. MDX-Net is 64 MB, loads in about two seconds, and
 * runs a six-second chunk in under three. It is what Ultimate Vocal Remover uses, and it
 * is the one that actually works in a browser.
 *
 * The model is spectral, so audio becomes an STFT first:
 *   input/output  float32 [1, 4, 3072, 256]
 *     4    = [left real, left imag, right real, right imag]
 *     3072 = frequency bins kept (of 3073 from a 6144-point FFT)
 *     256  = time frames at hop 1024
 * That is 261,120 samples per chunk, just under six seconds at 44.1 kHz.
 */

import * as ort from "onnxruntime-web/webgpu";
import { Spectral } from "./spectral.js";

const MODEL_URL =
  "https://huggingface.co/Politrees/UVR_resources/resolve/main/models/MDXNet/UVR-MDX-NET-Voc_FT.onnx";
const CACHE_NAME = "stemflipper-models-v1";
/** Matches the onnxruntime-web version in package.json; the wasm must not drift from it. */
const ORT_WASM_BASE = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.0/dist/";

const N_FFT = 6144;
const HOP = 1024;
const DIM_F = 3072;
const DIM_T = 256;
const CHUNK = HOP * (DIM_T - 1); // 261120 samples
const BINS = N_FFT / 2 + 1; // 3073
export const LOCAL_SR = 44100;
/** UVR applies a make-up gain to this model; without it the residual keeps a vocal ghost. */
const COMPENSATE = 1.021;

let session: ort.InferenceSession | null = null;
let spectral: InstanceType<typeof Spectral> | null = null;

type Out = Record<string, unknown>;
function post(type: string, payload: Out = {}): void {
  (self as unknown as Worker).postMessage({ ...payload, type });
}
function status(phase: string, pct: number, detail: string): void {
  post("status", { phase, pct, detail });
}

async function fetchModel(): Promise<Uint8Array> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open(CACHE_NAME);
  } catch {
    /* private browsing */
  }
  if (cache) {
    const hit = await cache.match(MODEL_URL);
    if (hit) {
      status("model", 100, "Model already on this device");
      return new Uint8Array(await hit.arrayBuffer());
    }
  }

  status("model", 0, "Downloading the model (64 MB, once per device)…");
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`Could not download the model (HTTP ${res.status})`);
  const total = Number(res.headers.get("content-length") || 0);
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    chunks.push(r.value);
    received += r.value.length;
    status(
      "model",
      total ? (received / total) * 100 : 0,
      `Downloading the model — ${(received / 1048576).toFixed(0)}${total ? ` of ${(total / 1048576).toFixed(0)}` : ""} MB`,
    );
  }
  const bytes = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.length;
  }
  if (cache) {
    try {
      await cache.put(MODEL_URL, new Response(bytes));
    } catch {
      /* storage quota */
    }
  }
  return bytes;
}

async function ensureSession(): Promise<ort.InferenceSession> {
  if (session) return session;

  ort.env.wasm.wasmPaths = ORT_WASM_BASE;
  ort.env.wasm.simd = true;
  ort.env.logLevel = "error";

  const bytes = await fetchModel();
  status("session", 0, "Starting the model…");

  // Prefer the GPU. Threads are set per path deliberately: on the WebGPU path the compute
  // is on the GPU, so a WASM thread pool buys nothing — and spinning one up inside an
  // already-nested worker stalls session creation for minutes. Only the CPU path asks.
  let used = "wasm";
  if ((navigator as { gpu?: unknown }).gpu) {
    try {
      ort.env.wasm.numThreads = 1;
      session = await ort.InferenceSession.create(bytes, { executionProviders: ["webgpu"] });
      used = "webgpu";
    } catch (e) {
      session = null;
      post("note", { message: `WebGPU unavailable (${(e as Error)?.message || e}), using the CPU` });
    }
  }
  if (!session) {
    // Threads matter enormously here: on one machine a chunk took ~140 s single-threaded
    // and ~45 s on seven. They only work when the page is cross-origin isolated, which
    // needs COOP/COEP headers the host has to send.
    ort.env.wasm.numThreads = self.crossOriginIsolated
      ? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1))
      : 1;
    session = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"] });
  }

  spectral = new Spectral(N_FFT, HOP);
  const threads = used === "wasm" ? (ort.env.wasm.numThreads as number) : 0;
  post("ready", {
    backend: used,
    threads,
    isolated: Boolean(self.crossOriginIsolated),
    // Measured wall-clock cost per second of audio, so the page can warn about a long
    // wait before someone commits to one.
    costPerSecond: used === "webgpu" ? 1.1 : threads > 1 ? 10 : 31,
  });
  return session;
}

/** The vocal for one chunk, as [left, right]. */
async function runChunk(left: Float32Array, right: Float32Array): Promise<Float32Array[]> {
  const spec = spectral!.forwardPair(left, right, DIM_T);

  const x = new Float32Array(4 * DIM_F * DIM_T);
  for (let b = 0; b < DIM_F; b++) {
    const o0 = (0 * DIM_F + b) * DIM_T;
    const o1 = (1 * DIM_F + b) * DIM_T;
    const o2 = (2 * DIM_F + b) * DIM_T;
    const o3 = (3 * DIM_F + b) * DIM_T;
    for (let f = 0; f < DIM_T; f++) {
      const s = f * BINS + b;
      x[o0 + f] = spec.lr[s];
      x[o1 + f] = spec.li[s];
      x[o2 + f] = spec.rr[s];
      x[o3 + f] = spec.ri[s];
    }
  }

  const out = await session!.run({ input: new ort.Tensor("float32", x, [1, 4, DIM_F, DIM_T]) });
  const y = out.output.data as Float32Array;

  // Back to full-height spectra; the bin above DIM_F stays zero, as the model was trained.
  const reL = new Float32Array(DIM_T * BINS);
  const imL = new Float32Array(DIM_T * BINS);
  const reR = new Float32Array(DIM_T * BINS);
  const imR = new Float32Array(DIM_T * BINS);
  for (let b = 0; b < DIM_F; b++) {
    const p0 = (0 * DIM_F + b) * DIM_T;
    const p1 = (1 * DIM_F + b) * DIM_T;
    const p2 = (2 * DIM_F + b) * DIM_T;
    const p3 = (3 * DIM_F + b) * DIM_T;
    for (let f = 0; f < DIM_T; f++) {
      const d = f * BINS + b;
      reL[d] = y[p0 + f] * COMPENSATE;
      imL[d] = y[p1 + f] * COMPENSATE;
      reR[d] = y[p2 + f] * COMPENSATE;
      imR[d] = y[p3 + f] * COMPENSATE;
    }
  }
  return spectral!.inversePair(reL, imL, reR, imR, DIM_T, CHUNK);
}

function ramp(len: number, edge: number): Float32Array {
  const w = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    w[i] = i < edge ? i / edge : i >= len - edge ? (len - 1 - i) / edge : 1;
  }
  return w;
}

async function separate(left: Float32Array, right: Float32Array) {
  await ensureSession();
  const n = left.length;
  const hop = Math.floor(CHUNK * 0.75);
  const edge = Math.floor((CHUNK - hop) / 2) || 1;
  const win = ramp(CHUNK, edge);

  const vocL = new Float32Array(n);
  const vocR = new Float32Array(n);
  const wsum = new Float32Array(n);

  const starts: number[] = [];
  for (let p = 0; p < n; p += hop) {
    starts.push(p);
    if (p + CHUNK >= n) break;
  }

  const inL = new Float32Array(CHUNK);
  const inR = new Float32Array(CHUNK);
  const t0 = Date.now();

  for (let si = 0; si < starts.length; si++) {
    const start = starts[si];
    const count = Math.min(CHUNK, n - start);
    inL.fill(0);
    inR.fill(0);
    for (let i = 0; i < count; i++) {
      inL[i] = left[start + i];
      inR[i] = right[start + i];
    }

    const eta = si > 0 ? Math.round((((Date.now() - t0) / si) * (starts.length - si)) / 1000) : null;
    status(
      "separate",
      (si / starts.length) * 100,
      `Separating — part ${si + 1} of ${starts.length}` +
        (eta !== null ? ` (about ${eta > 60 ? `${Math.ceil(eta / 60)} min` : `${eta} s`} left)` : ""),
    );

    const voc = await runChunk(inL, inR);
    for (let k = 0; k < count; k++) {
      vocL[start + k] += voc[0][k] * win[k];
      vocR[start + k] += voc[1][k] * win[k];
      wsum[start + k] += win[k];
    }
    await new Promise((r) => setTimeout(r, 0));
  }

  for (let j = 0; j < n; j++) {
    if (wsum[j] > 0.0001) {
      vocL[j] /= wsum[j];
      vocR[j] /= wsum[j];
    }
  }

  const insL = new Float32Array(n);
  const insR = new Float32Array(n);
  for (let m = 0; m < n; m++) {
    insL[m] = left[m] - vocL[m];
    insR[m] = right[m] - vocR[m];
  }
  return { vocals: [vocL, vocR], instrumental: [insL, insR] };
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data || {};
  try {
    if (msg.type === "warmup") {
      await ensureSession();
    } else if (msg.type === "separate") {
      const r = await separate(msg.left, msg.right);
      (self as unknown as Worker).postMessage(
        { type: "done", sampleRate: LOCAL_SR, vocals: r.vocals, instrumental: r.instrumental },
        [r.vocals[0].buffer, r.vocals[1].buffer, r.instrumental[0].buffer, r.instrumental[1].buffer],
      );
    }
  } catch (err) {
    post("error", { message: (err as Error)?.message || String(err) });
  }
};
