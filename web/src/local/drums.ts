/**
 * Drum transcription in the browser.
 *
 * basic-pitch on a drum stem produces nonsense: it is a pitch tracker, and a kit has no
 * pitch. The server runs `stemflipper/transcription/drums.py::transcribe_drums` whenever
 * the kit was not split — which is exactly our situation, since DrumSep does not run here.
 *
 * **What is ported verbatim and what is not, stated plainly:**
 *
 * - The CLASSIFIER is the server's, kernel for kernel (`drums.py:295-320`): a 50 ms window
 *   from the onset, the ratio of magnitude below 150 Hz and above 5 kHz, and the same
 *   thresholds and the same General MIDI pitches. So a hit the two agree on gets the same
 *   note number, and the exported MIDI lines up.
 * - The ONSET DETECTOR is not. The server uses `librosa.onset.onset_detect`, which is a
 *   mel-spectrogram flux with librosa's own `peak_pick` defaults; reproducing that
 *   faithfully means porting a mel filterbank and `power_to_db` as well, and a
 *   half-reproduced version would be worse than an honestly different one. This uses
 *   `tempo.js::onsetEnvelope` — the RMS flux already in this repo and already covered by
 *   the tempo tests — with the server's own two-pass threshold idea: pick permissively
 *   once, take the median strength of those peaks as "a typical hit here", then pick again
 *   relative to that. It adapts to how densely the kit is played, which a fixed threshold
 *   does not.
 *
 *   Two details there are not cosmetic. `onsetEnvelope` runs at 800 frames a second, where
 *   librosa's mel flux runs at about 43 and is smoothed by its own 2048-sample window. At
 *   800 fps the RMS of a 55 Hz kick RIPPLES inside the hit — twice per cycle — and each
 *   ripple reads as another onset: a test of four kicks came back with twelve. So the
 *   envelope is smoothed to a comparable resolution first, and a peak has to be the largest
 *   value in a +/-30 ms neighbourhood rather than merely larger than its two neighbours,
 *   which is what librosa's `pre_max`/`post_max` do for the same reason.
 *
 * So the hits are found differently and labelled identically. `transcription.engine` says
 * `drums_onset (browser)` rather than claiming to be the server's, and the pipeline records
 * a `fallback` note saying so.
 *
 * One further deviation, recorded because it is invisible otherwise: the server's classifier
 * takes an FFT of exactly the 2205-sample window. 2205 is neither a power of two nor three
 * times one, which is all `makeFFT` supports, so the window is zero-padded to 4096. That
 * interpolates the spectrum rather than changing it — the two band ratios move in the
 * fourth decimal — but it is not bit-identical.
 */

import { makeFFT } from "./spectral.js";
import { onsetEnvelope } from "./tempo.js";

/** General MIDI, same values as the server's drums.py. */
const GM_KICK = 36;
const GM_SNARE = 38;
const GM_HAT = 42;

/** Classifier window: 50 ms from the onset, as the server does. */
const WINDOW_S = 0.05;
const FFT_N = 4096;
/** Refractory period: two hits closer than this are one hit. Matches librosa's `wait`. */
const WAIT_S = 0.03;
/** A peak must be the largest value within this much either side (librosa's pre/post_max). */
const SPAN_S = 0.03;
/** Envelope smoothing, to bring 800 fps down to librosa's effective time resolution. */
const SMOOTH_S = 0.012;
/** Fraction of a typical hit's strength that still counts as a hit. */
const DELTA = 0.35;

export interface DrumNote {
  pitch: number;
  start: number;
  end: number;
  /** 0..1, so the shared `rowsFrom` turns it into a velocity the same way. */
  amplitude: number;
}

/** Moving average, so one hit is one bump rather than a train of ripples. */
function smooth(x: Float32Array, halfWidth: number): Float32Array {
  if (halfWidth < 1) return x;
  const out = new Float32Array(x.length);
  let sum = 0;
  const w = halfWidth * 2 + 1;
  for (let i = 0; i < x.length + halfWidth; i++) {
    if (i < x.length) sum += x[i];
    if (i - w >= 0) sum -= x[i - w];
    const at = i - halfWidth;
    if (at >= 0) out[at] = sum / Math.min(w, x.length);
  }
  return out;
}

/**
 * Peaks above `floor` that are the largest value within `span` frames either side and at
 * least `wait` frames from the one before.
 */
function pickPeaks(flux: Float32Array, floor: number, wait: number, span: number): number[] {
  const out: number[] = [];
  let last = -Infinity;
  for (let i = 1; i < flux.length - 1; i++) {
    const v = flux[i];
    if (v <= floor) continue;
    let isMax = true;
    const lo = Math.max(0, i - span);
    const hi = Math.min(flux.length - 1, i + span);
    for (let j = lo; j <= hi; j++) {
      if (flux[j] > v) {
        isMax = false;
        break;
      }
    }
    if (!isMax) continue;
    if (i - last < wait) {
      // Keep the louder of two hits inside the refractory window.
      if (out.length && v > flux[out[out.length - 1]]) {
        out[out.length - 1] = i;
        last = i;
      }
      continue;
    }
    out.push(i);
    last = i;
  }
  return out;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function transcribeDrums(mono: Float32Array, sampleRate: number): DrumNote[] {
  if (!mono.length) return [];
  const raw = onsetEnvelope(mono, sampleRate);
  const rate = raw.rate;
  if (!raw.flux.length) return [];
  const flux = smooth(raw.flux, Math.round(SMOOTH_S * rate));

  let max = 0;
  for (let i = 0; i < flux.length; i++) max = Math.max(max, flux[i]);
  if (max <= 0) return [];

  // Two passes: a permissive pick to learn what a typical hit looks like here, then a
  // real pick relative to that. A single global threshold is not a usable reference —
  // it swings with how densely the kit is played.
  const wait = Math.max(1, Math.round(WAIT_S * rate));
  const span = Math.max(1, Math.round(SPAN_S * rate));
  const rough = pickPeaks(flux, 0.02 * max, wait, span);
  const typical = median(rough.map((i) => flux[i])) || 0.1 * max;
  const peaks = pickPeaks(flux, DELTA * typical, wait, span);

  const win = Math.max(2, Math.floor(WINDOW_S * sampleRate));
  const fft = makeFFT(FFT_N);
  const re = new Float32Array(FFT_N);
  const im = new Float32Array(FFT_N);

  let globalPeak = 0;
  for (let i = 0; i < mono.length; i += 8) globalPeak = Math.max(globalPeak, Math.abs(mono[i]));
  if (globalPeak <= 0) globalPeak = 1;

  const binHz = sampleRate / FFT_N;
  const loBin = Math.floor(150 / binHz);
  const hiBin = Math.ceil(5000 / binHz);
  const notes: DrumNote[] = [];

  for (const p of peaks) {
    const t = p / rate;
    const at = Math.round(t * sampleRate);
    if (at + win / 2 > mono.length) continue;

    let segPeak = 0;
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < win && at + i < mono.length; i++) {
      const v = mono[at + i];
      re[i] = v;
      segPeak = Math.max(segPeak, Math.abs(v));
    }
    if (segPeak < 1e-4) continue;

    fft.run(re, im, false);
    let total = 0;
    let low = 0;
    let high = 0;
    for (let k = 0; k <= FFT_N / 2; k++) {
      const m = Math.hypot(re[k], im[k]);
      total += m;
      if (k < loBin) low += m;
      if (k > hiBin) high += m;
    }
    if (total <= 0) continue;
    const lowRatio = low / total;
    const highRatio = high / total;

    // A coincident hat adds ~0.4 to the high-band ratio, so only near-pure HF is a hat.
    const pitch = lowRatio > 0.25 ? GM_KICK : highRatio > 0.7 ? GM_HAT : GM_SNARE;
    const velocity = Math.max(20, Math.min(127, Math.round((segPeak / globalPeak) * 127)));
    notes.push({
      pitch,
      start: Number(t.toFixed(4)),
      end: Number((t + 0.1).toFixed(4)),
      amplitude: velocity / 127,
    });
  }

  return notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}
