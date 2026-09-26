/**
 * Spleeter 4stems in the browser: vocals, drums, bass, other.
 *
 * The four ONNX graphs take magnitudes and return magnitudes, so everything either side of
 * them is ours: the STFT, the soft ratio mask, the band extension and the iSTFT. Each of
 * those four has a way to be subtly wrong that still sounds roughly right, so the invariant
 * below is the thing to check, not your ears.
 *
 * **The invariant.** Spleeter's ratio masks sum to 1 by construction, so the four stems MUST
 * reconstruct the mix. They do, to −165 dB (measured on a 4-minute track). That single
 * number tests the window, the hop, the mask and the band extension at once. If it drifts
 * up to about −23 dB the band extension has reverted to `zeros`; if it lands near −77 dB
 * something quantised to 16-bit on the way. `residualDb()` computes it and the pipeline puts
 * it in `project.json` as `separation.residual_db`, which is also what the server reports.
 *
 * Three details that are load-bearing, each learned the hard way by someone:
 *
 * 1. **Periodic** Hann, not symmetric. `hannPeriodic` from spectral.js is right; numpy's
 *    `np.hanning(n)` is the symmetric one and differs by a single sample — the difference
 *    between matching the training-time spectrograms and merely resembling them.
 * 2. The mask is applied to the **original complex spectrum**, so the phase is already
 *    correct and there is nothing to reconstruct.
 * 3. The net only models 1024 of 2049 bins (to ~11 kHz). The rest is carried up with the
 *    per-frame mean of the mask ("average"). Spleeter's own default is `zeros`, which throws
 *    that band away and costs 23 dB of reconstruction.
 *
 * Work is done SPLIT BY SPLIT rather than whole-file. Doing it whole-file needs the entire
 * complex spectrogram and all four stem outputs live at once: 1471 MB on a 4-minute track,
 * and it went superlinear under GC pressure (0.81 s/s against 0.21 s/s here). Streaming a
 * few splits at a time holds the heap flat at ~625 MB for a numerically identical result.
 */

import { hannPeriodic, makeFFT } from "./spectral.js";
import { SPLEETER_BASE, SPLEETER_STEMS } from "./engines";
import { createSession, fetchModel, tensor, type ORT, type StatusFn } from "./ortRuntime";

const N_FFT = 4096;
const HOP = 1024;
/** Frames per split, and bins the net models, both fixed by the graph. */
const T = 512;
const F = 1024;
const BINS = N_FFT / 2 + 1; // 2049
/** Front pad, so frame 0 is centred the way the export expects. */
const PAD = N_FFT - HOP; // 3072
/** Splits per inference call: bounds peak memory while amortising call overhead. */
const SPLIT_BATCH = 4;

const STEMS = SPLEETER_STEMS;

export interface SpleeterResult {
  /** stem id -> [left, right] at 44.1 kHz. */
  stems: Record<string, Float32Array[]>;
  backend: string;
  threads: number;
  /** rms(mix - sum(stems)) in dBFS. Should be about -165. */
  residualDb: number;
}

let sessions: Record<string, ORT.InferenceSession> | null = null;
let sessionBackend = "wasm";
let sessionThreads = 1;

export function spleeterUrls(): string[] {
  return STEMS.map((s) => `${SPLEETER_BASE}${s}.fp16.onnx`);
}

async function ensureSessions(status: StatusFn): Promise<Record<string, ORT.InferenceSession>> {
  if (sessions) return sessions;
  const out: Record<string, ORT.InferenceSession> = {};
  let i = 0;
  for (const s of STEMS) {
    i++;
    const bytes = await fetchModel(
      `${SPLEETER_BASE}${s}.fp16.onnx`,
      `the models (79 MB, once per device) — part ${i} of ${STEMS.length}`,
      status,
    );
    status("session", (i / STEMS.length) * 100, "Starting the models…");
    const r = await createSession(bytes);
    out[s] = r.session;
    sessionBackend = r.backend;
    sessionThreads = r.threads;
  }
  sessions = out;
  return out;
}

/** rms of (mix - sum(stems)), in dBFS. The invariant described at the top. */
export function residualDb(
  left: Float32Array,
  right: Float32Array,
  stems: Record<string, Float32Array[]>,
): number {
  const n = left.length;
  let sum = 0;
  const ids = Object.keys(stems);
  for (let i = 0; i < n; i++) {
    let l = left[i];
    let r = right[i];
    for (const id of ids) {
      l -= stems[id][0][i];
      r -= stems[id][1][i];
    }
    sum += l * l + r * r;
  }
  const rms = Math.sqrt(sum / (2 * n));
  return rms > 0 ? Number((20 * Math.log10(rms)).toFixed(1)) : -200;
}

export async function separateSpleeter(
  left: Float32Array,
  right: Float32Array,
  status: StatusFn,
): Promise<SpleeterResult> {
  const ss = await ensureSessions(status);
  const n = left.length;
  const frames = Math.ceil((PAD + n) / HOP);
  const splits = Math.ceil(frames / T);
  const total = (frames - 1) * HOP + N_FFT;

  const win = hannPeriodic(N_FFT);
  const fft = makeFFT(N_FFT);

  // The only full-length buffers: the four stereo results, plus ONE window sum. The sum is
  // identical for every stem and channel, so it is accumulated once.
  const acc: Record<string, Float32Array[]> = {};
  for (const s of STEMS) acc[s] = [new Float32Array(total), new Float32Array(total)];
  const wsum = new Float32Array(total);

  const fre = new Float32Array(N_FFT);
  const fim = new Float32Array(N_FFT);
  const denom = new Float32Array(F);
  const t0 = Date.now();

  for (let s0 = 0; s0 < splits; s0 += SPLIT_BATCH) {
    const nb = Math.min(SPLIT_BATCH, splits - s0);
    const bFrames = nb * T;
    const perCh = bFrames * F;

    // Forward STFT for this batch only.
    const re = new Float32Array(2 * bFrames * BINS);
    const im = new Float32Array(2 * bFrames * BINS);
    const mag = new Float32Array(2 * perCh);
    for (let c = 0; c < 2; c++) {
      const src = c === 0 ? left : right;
      for (let t = 0; t < bFrames; t++) {
        const at = (s0 * T + t) * HOP;
        fre.fill(0);
        fim.fill(0);
        for (let i = 0; i < N_FFT; i++) {
          const a = at + i - PAD;
          fre[i] = (a >= 0 && a < n ? src[a] : 0) * win[i];
        }
        fft.run(fre, fim, false);
        const o = (c * bFrames + t) * BINS;
        const mo = c * perCh + t * F;
        for (let k = 0; k < BINS; k++) {
          re[o + k] = fre[k];
          im[o + k] = fim[k];
        }
        for (let f = 0; f < F; f++) mag[mo + f] = Math.hypot(re[o + f], im[o + f]);
      }
    }

    // Every stem must run: the mask denominator needs all four.
    const est: Record<string, Float32Array> = {};
    for (const s of STEMS) {
      const x = tensor(mag, [2, nb, T, F]);
      const out = await ss[s].run({ x });
      est[s] = (out.y.data as Float32Array).slice();
      try {
        x.dispose();
        out.y.dispose();
      } catch {
        /* older runtimes have no dispose */
      }
    }

    // Mask, band-extend, iSTFT straight into the accumulators.
    for (let c = 0; c < 2; c++) {
      for (let t = 0; t < bFrames; t++) {
        const gf = s0 * T + t;
        const at = gf * HOP;
        const so = (c * bFrames + t) * BINS;
        const eo = c * perCh + t * F;
        for (let f = 0; f < F; f++) {
          let d = 1e-10;
          for (const o2 of STEMS) {
            const v = est[o2][eo + f];
            d += v * v;
          }
          denom[f] = d;
        }
        for (const s of STEMS) {
          const e = est[s];
          fre.fill(0);
          fim.fill(0);
          let maskSum = 0;
          for (let f = 0; f < F; f++) {
            const v = e[eo + f];
            const m = (v * v + 1e-10 / STEMS.length) / denom[f];
            fre[f] = re[so + f] * m;
            fim[f] = im[so + f] * m;
            maskSum += m;
          }
          const mean = maskSum / F;
          for (let f = F; f < BINS; f++) {
            fre[f] = re[so + f] * mean;
            fim[f] = im[so + f] * mean;
          }
          // Hermitian mirror, then an in-place inverse transform.
          for (let k = 1; k < BINS - 1; k++) {
            fre[N_FFT - k] = fre[k];
            fim[N_FFT - k] = -fim[k];
          }
          fft.run(fre, fim, true);
          const dst = acc[s][c];
          for (let i = 0; i < N_FFT && at + i < total; i++) dst[at + i] += fre[i] * win[i];
        }
        if (c === 0) {
          for (let i = 0; i < N_FFT && at + i < total; i++) wsum[at + i] += win[i] * win[i];
        }
      }
    }

    const done = Math.min(s0 + nb, splits);
    const eta = done < splits ? Math.round(((Date.now() - t0) / done) * (splits - done) / 1000) : 0;
    status(
      "separate",
      (done / splits) * 100,
      `Separating — part ${done} of ${splits}` +
        (eta > 0 ? ` (about ${eta > 60 ? `${Math.ceil(eta / 60)} min` : `${eta} s`} left)` : ""),
    );
    await new Promise((r) => setTimeout(r, 0));
  }

  // Normalise by the shared window sum, then drop the front pad.
  const stems: Record<string, Float32Array[]> = {};
  for (const s of STEMS) {
    const pair: Float32Array[] = [];
    for (let c = 0; c < 2; c++) {
      const b = acc[s][c];
      for (let i = 0; i < total; i++) if (wsum[i] > 1e-8) b[i] /= wsum[i];
      pair.push(new Float32Array(b.subarray(PAD, PAD + n)));
    }
    acc[s] = [];
    stems[s] = pair;
  }

  return {
    stems,
    backend: sessionBackend,
    threads: sessionThreads,
    residualDb: residualDb(left, right, stems),
  };
}
