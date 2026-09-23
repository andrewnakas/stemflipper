/**
 * Tempo, beat grid and key, computed in the browser.
 *
 * The server uses Beat This! and librosa for this; neither runs here, so this is the
 * honest, simpler substitute: a validated tempo detector, a beat phase found by
 * correlating the onset envelope against a pulse train, and Krumhansl-Schmuckler key
 * estimation over an averaged chroma. `grid.source` says "browser" so the page can tell
 * you which one you got, rather than implying a beat tracker ran.
 */

import { makeFFT } from "./spectral.js";
import { analyse, onsetEnvelope, toMono } from "./tempo.js";
import type { Grid } from "../model/types";

export interface LocalAnalysis {
  grid: Grid;
  key: { name: string; tonic: number | null; mode: string | null; confidence: number };
  tempoConfidence: number;
}

/**
 * Where the beats actually fall.
 *
 * A tempo gives spacing but not phase, and a grid that is right about spacing and wrong
 * about phase puts every bar line between the beats. Slide a pulse train across one
 * beat's worth of offsets and keep the offset with the most onset energy under it.
 */
export function beatPhase(flux: Float32Array, rate: number, bpm: number): number {
  const period = (60 / bpm) * rate; // in envelope frames
  if (!(period > 1) || flux.length < period * 2) return 0;

  let best = 0;
  let bestScore = -Infinity;
  const steps = Math.max(8, Math.round(period));
  for (let s = 0; s < steps; s++) {
    const offset = (s / steps) * period;
    let score = 0;
    for (let t = offset; t < flux.length; t += period) {
      const i = Math.round(t);
      if (i >= 0 && i < flux.length) score += flux[i];
    }
    if (score > bestScore) {
      bestScore = score;
      best = offset;
    }
  }
  return best / rate; // seconds
}

export function buildBeats(bpm: number, phaseS: number, duration: number, beatsPerBar = 4): Grid {
  const spacing = 60 / bpm;
  const beats: number[] = [];
  const downbeats: number[] = [];
  let i = 0;
  for (let t = phaseS; t < duration; t += spacing, i++) {
    beats.push(Number(t.toFixed(4)));
    if (i % beatsPerBar === 0) downbeats.push(Number(t.toFixed(4)));
  }
  return {
    tempo: Number(bpm.toFixed(2)),
    time_signature: `${beatsPerBar}/4`,
    beats,
    downbeats,
    tempo_map: [[0, Number(bpm.toFixed(2))]],
    source: "browser",
  };
}

/* ------------------------------------------------------------------------- key */

const KEY_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
// Krumhansl-Schmuckler profiles.
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/** Average chroma over the track, from a 2048-point FFT on a mono downmix. */
export function chromaOf(mono: Float32Array, sampleRate: number): Float32Array {
  const N = 2048;
  const hop = 1024;
  const fft = makeFFT(N);
  const chroma = new Float32Array(12);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);

  // Only bins in a musical range contribute; below ~55 Hz and above ~2 kHz is mostly
  // rumble and cymbal noise, and both smear the profile.
  const loBin = Math.max(1, Math.floor((55 / sampleRate) * N));
  const hiBin = Math.min(N / 2, Math.ceil((2000 / sampleRate) * N));

  for (let start = 0; start + N <= mono.length; start += hop) {
    for (let i = 0; i < N; i++) {
      re[i] = mono[start + i] * win[i];
      im[i] = 0;
    }
    fft.run(re, im, false);
    for (let b = loBin; b < hiBin; b++) {
      const mag = Math.hypot(re[b], im[b]);
      if (mag <= 0) continue;
      const hz = (b * sampleRate) / N;
      const midi = 69 + 12 * Math.log2(hz / 440);
      const pc = ((Math.round(midi) % 12) + 12) % 12;
      chroma[pc] += mag;
    }
  }
  let total = 0;
  for (const v of chroma) total += v;
  if (total > 0) for (let i = 0; i < 12; i++) chroma[i] /= total;
  return chroma;
}

function correlate(a: Float32Array | number[], b: number[], rotate: number): number {
  const n = 12;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[(i + rotate) % n] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

export function estimateKey(chroma: Float32Array): LocalAnalysis["key"] {
  let best = { score: -Infinity, tonic: 0, mode: "major" };
  for (let t = 0; t < 12; t++) {
    const maj = correlate(chroma, MAJOR, t);
    const min = correlate(chroma, MINOR, t);
    if (maj > best.score) best = { score: maj, tonic: t, mode: "major" };
    if (min > best.score) best = { score: min, tonic: t, mode: "minor" };
  }
  return {
    name: `${KEY_NAMES[best.tonic]} ${best.mode}`,
    tonic: best.tonic,
    mode: best.mode,
    confidence: Number(Math.max(0, best.score).toFixed(3)),
  };
}

/** Everything the project needs about time and key, from the decoded mix. */
export function analyseLocally(buffer: AudioBuffer): LocalAnalysis {
  const mono = toMono(buffer);
  const { bpm, confidence } = analyse(buffer);
  const env = onsetEnvelope(mono, buffer.sampleRate);
  const phase = beatPhase(env.flux, env.rate, bpm);
  return {
    grid: buildBeats(bpm, phase, buffer.duration),
    key: estimateKey(chromaOf(mono, buffer.sampleRate)),
    tempoConfidence: confidence,
  };
}
