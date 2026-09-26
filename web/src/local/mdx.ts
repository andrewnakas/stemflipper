/**
 * UVR-MDX-NET-Voc_FT: vocal + instrumental.
 *
 * Moved out of local.worker.ts unchanged when the worker grew a second and third engine —
 * same algorithm, same constants, same numerics. Ported originally from audiosaw.com's
 * js/stem-worker.js, where it has been in production.
 *
 * The model is spectral, so audio becomes an STFT first:
 *   input/output  float32 [1, 4, 3072, 256]
 *     4    = [left real, left imag, right real, right imag]
 *     3072 = frequency bins kept (of 3073 from a 6144-point FFT)
 *     256  = time frames at hop 1024
 * That is 261,120 samples per chunk, just under six seconds at 44.1 kHz.
 *
 * The instrumental is the residual, `mix - vocals`, which keeps the two exactly
 * complementary — this engine's equivalent of the sum-to-mix guarantee the others have.
 */

import { Spectral } from "./spectral.js";
import { MDX_URL } from "./engines";
import { createSession, fetchModel, tensor, type ORT, type StatusFn } from "./ortRuntime";

const N_FFT = 6144;
const HOP = 1024;
const DIM_F = 3072;
const DIM_T = 256;
const CHUNK = HOP * (DIM_T - 1); // 261120 samples
const BINS = N_FFT / 2 + 1; // 3073
/** UVR applies a make-up gain to this model; without it the residual keeps a vocal ghost. */
const COMPENSATE = 1.021;

export interface MdxResult {
  stems: Record<string, Float32Array[]>;
  backend: string;
  threads: number;
}

let session: ORT.InferenceSession | null = null;
let spectral: InstanceType<typeof Spectral> | null = null;
let sessionBackend = "wasm";
let sessionThreads = 1;

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

  const out = await session!.run({ input: tensor(x, [1, 4, DIM_F, DIM_T]) });
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

export async function separateMdx(
  left: Float32Array,
  right: Float32Array,
  status: StatusFn,
): Promise<MdxResult> {
  if (!session) {
    const bytes = await fetchModel(MDX_URL, "the model (64 MB, once per device)", status);
    status("session", 0, "Starting the model…");
    const r = await createSession(bytes);
    session = r.session;
    sessionBackend = r.backend;
    sessionThreads = r.threads;
    spectral = new Spectral(N_FFT, HOP);
  }

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
  return {
    stems: { vocals: [vocL, vocR], instrumental: [insL, insR] },
    backend: sessionBackend,
    threads: sessionThreads,
  };
}
