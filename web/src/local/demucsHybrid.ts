/**
 * htdemucs in the browser — the quality option, and the slow one.
 *
 * This export (timcsy/demucs-web-onnx, MIT) is the only htdemucs ONNX that onnxruntime-web
 * can load, and the reason is that the STFT and iSTFT are NOT in the graph. It takes the
 * waveform *and* a pre-computed spectrogram, and returns two branches:
 *
 *     input (1,2,343980) + x (1,4,2048,336)  ->  output (1,4,4,2048,336) + time (1,4,2,343980)
 *     stem = time_branch + iSTFT(spectral_branch)
 *
 * htdemucs is a hybrid model; forgetting to add the two branches gives you audio that
 * sounds like a bad mix rather than an obvious failure. Verified against real Space output:
 * correlation 0.91-0.99 per stem, sum-to-mix −40 dB.
 *
 * Framing is demucs' `_spec`/`_ispec` and has to match exactly: reflect-pad by
 * `hop//2*3 = 1536`, pad right to a whole number of hops, reflect-pad `n_fft/2 = 2048` for
 * centring, transform, then keep frames [2, 338) and bins [0, 2048). The inverse puts two
 * empty frames back at each end and slices at `2048 + 1536 = 3584`. Ported from
 * timcsy/demucs-web's processor.js, whose numerics are torch's with normalized=True.
 *
 * ⚠️ It costs ~18x realtime on an M1 (about 100 s per 7.8 s segment) — a 3:30 song is over
 * an hour. That is not an onnxruntime-web defect: native onnxruntime on CPU on the same
 * machine is ~10x realtime. The model is simply heavy. `engines.ts` never defaults to it.
 */

import { hannPeriodic, makeFFT } from "./spectral.js";
import { HTDEMUCS_STEMS, HTDEMUCS_URL } from "./engines";
import { createSession, fetchModel, tensor, type ORT, type StatusFn } from "./ortRuntime";
import { residualDb } from "./spleeter";

const SEG = 343980; // 7.8 s at 44.1 kHz, baked into the graph
const OVERLAP = SEG >> 2; // 85995
const STRIDE = SEG - OVERLAP; // 257985
const N_FFT = 4096;
const HOP = 1024;
const SPEC_BINS = 2048;
const SPEC_FRAMES = 336;
const BINS = N_FFT / 2 + 1; // 2049
const PAD = Math.floor(HOP / 2) * 3; // 1536
const CENTER = N_FFT / 2; // 2048
const FRAME_OFFSET = 2;

export interface DemucsResult {
  stems: Record<string, Float32Array[]>;
  backend: string;
  threads: number;
  /**
   * rms(mix - sum(stems)) in dBFS. htdemucs is not mask-based, so its stems are not
   * required to reconstruct the mix the way Spleeter's are, and this sits around -40 dB
   * rather than -165. Reported anyway so every four-stem engine puts the same number in
   * `project.json` and the Listen screen can compare like with like.
   */
  residualDb: number;
}

let session: ORT.InferenceSession | null = null;
let sessionBackend = "wasm";
let sessionThreads = 1;

/** Reflect padding, matching torch's `F.pad(mode="reflect")`. */
function reflectPad(sig: Float32Array, padL: number, padR: number): Float32Array {
  const n = sig.length;
  const out = new Float32Array(padL + n + padR);
  for (let i = 0; i < padL; i++) out[i] = sig[Math.min(padL - i, n - 1)];
  out.set(sig, padL);
  for (let i = 0; i < padR; i++) out[padL + n + i] = sig[Math.max(0, n - 2 - i)];
  return out;
}

const fft = makeFFT(N_FFT);
const win = hannPeriodic(N_FFT);
/** torch.stft(normalized=True) scales the forward transform by 1/sqrt(n_fft). */
const FWD_SCALE = 1 / Math.sqrt(N_FFT);
const INV_SCALE = Math.sqrt(N_FFT);

function stftFrames(sig: Float32Array): { re: Float32Array; im: Float32Array; frames: number } {
  const frames = Math.floor((sig.length - N_FFT) / HOP) + 1;
  const re = new Float32Array(frames * BINS);
  const im = new Float32Array(frames * BINS);
  const fr = new Float32Array(N_FFT);
  const fi = new Float32Array(N_FFT);
  for (let f = 0; f < frames; f++) {
    const s = f * HOP;
    fi.fill(0);
    for (let i = 0; i < N_FFT; i++) fr[i] = sig[s + i] * win[i];
    fft.run(fr, fi, false);
    const o = f * BINS;
    for (let k = 0; k < BINS; k++) {
      re[o + k] = fr[k] * FWD_SCALE;
      im[o + k] = fi[k] * FWD_SCALE;
    }
  }
  return { re, im, frames };
}

function istftInto(
  sre: Float32Array,
  sim: Float32Array,
  frames: number,
  length: number,
): Float32Array {
  const out = new Float32Array(length);
  const wsum = new Float32Array(length);
  const fr = new Float32Array(N_FFT);
  const fi = new Float32Array(N_FFT);
  for (let f = 0; f < frames; f++) {
    fr.fill(0);
    fi.fill(0);
    const o = f * BINS;
    for (let k = 0; k < BINS; k++) {
      fr[k] = sre[o + k];
      fi[k] = sim[o + k];
    }
    for (let k = 1; k < BINS - 1; k++) {
      fr[N_FFT - k] = fr[k];
      fi[N_FFT - k] = -fi[k];
    }
    fft.run(fr, fi, true);
    const s = f * HOP;
    for (let i = 0; i < N_FFT && s + i < length; i++) {
      out[s + i] += fr[i] * win[i] * INV_SCALE;
      wsum[s + i] += win[i] * win[i];
    }
  }
  for (let i = 0; i < length; i++) if (wsum[i] > 1e-8) out[i] /= wsum[i];
  return out;
}

/** The two feeds for one zero-padded segment. */
function prepare(segL: Float32Array, segR: Float32Array): { wav: Float32Array; x: Float32Array } {
  const le = Math.ceil(SEG / HOP); // 336
  const padRight = PAD + le * HOP - SEG; // 1620
  const specOf = (ch: Float32Array) =>
    stftFrames(reflectPad(reflectPad(ch, PAD, padRight), CENTER, CENTER));
  const sl = specOf(segL);
  const sr = specOf(segR);
  const plane = SPEC_BINS * SPEC_FRAMES;
  const x = new Float32Array(4 * plane);
  for (let f = 0; f < SPEC_FRAMES; f++) {
    const src = (f + FRAME_OFFSET) * BINS;
    for (let b = 0; b < SPEC_BINS; b++) {
      const d = b * SPEC_FRAMES + f;
      x[d] = sl.re[src + b];
      x[plane + d] = sl.im[src + b];
      x[2 * plane + d] = sr.re[src + b];
      x[3 * plane + d] = sr.im[src + b];
    }
  }
  const wav = new Float32Array(2 * SEG);
  wav.set(segL, 0);
  wav.set(segR, SEG);
  return { wav, x };
}

/** One stem's spectral branch, back in the time domain. */
function ispecStem(freq: Float32Array, t: number): Float32Array[] {
  const pBins = SPEC_BINS + 1;
  const pFrames = SPEC_FRAMES + 4;
  const plane = SPEC_BINS * SPEC_FRAMES;
  const base = t * 4 * plane;
  const build = (c0: number, c1: number) => {
    const re = new Float32Array(pFrames * pBins);
    const im = new Float32Array(pFrames * pBins);
    for (let f = 0; f < SPEC_FRAMES; f++) {
      const d = (f + FRAME_OFFSET) * pBins;
      for (let b = 0; b < SPEC_BINS; b++) {
        re[d + b] = freq[base + c0 * plane + b * SPEC_FRAMES + f];
        im[d + b] = freq[base + c1 * plane + b * SPEC_FRAMES + f];
      }
    }
    return { re, im };
  };
  const L = build(0, 1);
  const R = build(2, 3);
  const len = (pFrames - 1) * HOP + N_FFT;
  const off = CENTER + PAD; // 3584
  const l = istftInto(L.re, L.im, pFrames, len);
  const r = istftInto(R.re, R.im, pFrames, len);
  return [l.subarray(off, off + SEG), r.subarray(off, off + SEG)];
}

/** linspace(0,1,OVERLAP) in, mirrored out, flat across the middle. */
function segmentWindow(): Float32Array {
  const w = new Float32Array(SEG).fill(1);
  for (let i = 0; i < OVERLAP; i++) {
    const v = i / (OVERLAP - 1);
    w[i] = v;
    w[SEG - 1 - i] = v;
  }
  return w;
}

export async function separateHtdemucs(
  left: Float32Array,
  right: Float32Array,
  status: StatusFn,
): Promise<DemucsResult> {
  if (!session) {
    const bytes = await fetchModel(HTDEMUCS_URL, "the model (180 MB, once per device)", status);
    status("session", 0, "Starting the model…");
    const r = await createSession(bytes);
    session = r.session;
    sessionBackend = r.backend;
    sessionThreads = r.threads;
  }
  const s = session;
  const n = left.length;
  const nChunks = Math.max(1, Math.ceil(n / STRIDE));
  const win2 = segmentWindow();

  const acc: Record<string, Float32Array[]> = {};
  for (const id of HTDEMUCS_STEMS) acc[id] = [new Float32Array(n), new Float32Array(n)];
  const weight = new Float32Array(n);
  const segL = new Float32Array(SEG);
  const segR = new Float32Array(SEG);
  const t0 = Date.now();

  for (let c = 0; c < nChunks; c++) {
    const start = c * STRIDE;
    const count = Math.min(SEG, n - start);
    if (count <= 0) break;
    segL.fill(0);
    segR.fill(0);
    for (let i = 0; i < count; i++) {
      segL[i] = left[start + i];
      segR[i] = right[start + i];
    }

    const eta = c > 0 ? Math.round((((Date.now() - t0) / c) * (nChunks - c)) / 1000) : null;
    status(
      "separate",
      (c / nChunks) * 100,
      `Separating — part ${c + 1} of ${nChunks}` +
        (eta !== null ? ` (about ${eta > 60 ? `${Math.ceil(eta / 60)} min` : `${eta} s`} left)` : ""),
    );

    const fed = prepare(segL, segR);
    const tw = tensor(fed.wav, [1, 2, SEG]);
    const tx = tensor(fed.x, [1, 4, SPEC_BINS, SPEC_FRAMES]);
    const out = await s.run({ [s.inputNames[0]]: tw, [s.inputNames[1]]: tx });

    let time: ORT.Tensor | null = null;
    let freq: ORT.Tensor | null = null;
    for (const nm of s.outputNames) {
      const T = out[nm] as ORT.Tensor;
      if (T.dims.length === 4 && T.dims[2] === 2) time = T;
      else if (T.dims.length === 5 && T.dims[2] === 4) freq = T;
    }
    if (!time) throw new Error("htdemucs returned no time-domain output");
    const td = time.data as Float32Array;
    const fd = freq ? (freq.data as Float32Array) : null;

    HTDEMUCS_STEMS.forEach((id, si) => {
      const sp = fd ? ispecStem(fd, si) : null;
      for (let ch = 0; ch < 2; ch++) {
        const base = (si * 2 + ch) * SEG;
        const dst = acc[id][ch];
        for (let k = 0; k < count; k++) {
          dst[start + k] += (td[base + k] + (sp ? sp[ch][k] : 0)) * win2[k];
        }
      }
    });
    for (let k = 0; k < count; k++) weight[start + k] += win2[k];
    try {
      tw.dispose();
      tx.dispose();
      time.dispose();
      freq?.dispose();
    } catch {
      /* older runtimes have no dispose */
    }
    await new Promise((r) => setTimeout(r, 0));
  }

  for (const id of HTDEMUCS_STEMS) {
    for (let ch = 0; ch < 2; ch++) {
      const b = acc[id][ch];
      for (let i = 0; i < n; i++) b[i] /= Math.max(weight[i], 1e-8);
    }
  }
  return {
    stems: acc,
    backend: sessionBackend,
    threads: sessionThreads,
    residualDb: residualDb(left, right, acc),
  };
}
