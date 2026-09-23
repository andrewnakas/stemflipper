/**
 * basic-pitch note extraction, in the browser.
 *
 * The model (230 KB of ONNX) turns 2-second windows of 22.05 kHz mono into three
 * matrices — frame activations, onset activations and a finer pitch contour. Turning
 * those into notes is the part that matters, and it is a faithful port of
 * `basic_pitch.note_creation.output_to_notes_polyphonic`, because the thresholds the
 * server uses were tuned against exactly this algorithm.
 *
 * Kept free of any ONNX or DOM reference so it can be tested directly.
 */

export const BP_SAMPLE_RATE = 22050;
export const BP_FFT_HOP = 256;
export const BP_N_SAMPLES = 43844;
export const BP_N_OVERLAPPING_FRAMES = 30;
export const BP_OVERLAP_LEN = BP_N_OVERLAPPING_FRAMES * BP_FFT_HOP; // 7680
export const BP_HOP_SIZE = BP_N_SAMPLES - BP_OVERLAP_LEN; // 36164
export const BP_FRAMES_PER_WINDOW = 172;
export const ANNOTATIONS_FPS = BP_SAMPLE_RATE / BP_FFT_HOP; // 86.1328125
/** Output row 0 is MIDI 21 (A0). */
export const MIDI_OFFSET = 21;
export const N_PITCHES = 88;

/** A [frames][pitches] matrix as a flat array plus its width. */
export interface Matrix {
  data: Float32Array;
  rows: number;
  cols: number;
}

export function at(m: Matrix, r: number, c: number): number {
  return m.data[r * m.cols + c];
}
function set(m: Matrix, r: number, c: number, v: number): void {
  m.data[r * m.cols + c] = v;
}
function zerosLike(m: Matrix): Matrix {
  return { data: new Float32Array(m.rows * m.cols), rows: m.rows, cols: m.cols };
}

export interface BpNote {
  /** Seconds. */
  start: number;
  end: number;
  pitch: number;
  /** 0..1 mean frame activation over the note. */
  amplitude: number;
}

export interface BpOptions {
  onsetThreshold?: number;
  frameThreshold?: number;
  /** Milliseconds. */
  minNoteLength?: number;
  minFreqHz?: number | null;
  maxFreqHz?: number | null;
  inferOnsets?: boolean;
  /** Frames of sub-threshold energy tolerated inside a note before it ends. */
  energyTolerance?: number;
}

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Zero out rows outside the frequency range this instrument can produce. */
function constrainFrequency(onsets: Matrix, frames: Matrix, minHz: number | null, maxHz: number | null): void {
  for (let c = 0; c < frames.cols; c++) {
    const hz = midiToHz(c + MIDI_OFFSET);
    if ((maxHz != null && hz > maxHz) || (minHz != null && hz < minHz)) {
      for (let r = 0; r < frames.rows; r++) {
        set(frames, r, c, 0);
        set(onsets, r, c, 0);
      }
    }
  }
}

/**
 * Add onsets the onset head missed, from sharp rises in the frame activations.
 *
 * A note that starts quietly often has no onset peak but a clear jump in energy; without
 * this the note is simply absent.
 */
export function inferredOnsets(onsets: Matrix, frames: Matrix, nDiff = 2): Matrix {
  const out = zerosLike(onsets);
  const diff = zerosLike(frames);
  let maxDiff = 0;

  for (let r = 0; r < frames.rows; r++) {
    for (let c = 0; c < frames.cols; c++) {
      let smallest = Infinity;
      for (let n = 1; n <= nDiff; n++) {
        const prev = r - n >= 0 ? at(frames, r - n, c) : 0;
        smallest = Math.min(smallest, at(frames, r, c) - prev);
      }
      const v = r < nDiff ? 0 : Math.max(0, smallest);
      set(diff, r, c, v);
      if (v > maxDiff) maxDiff = v;
    }
  }

  let maxOnset = 0;
  for (let i = 0; i < onsets.data.length; i++) maxOnset = Math.max(maxOnset, onsets.data[i]);
  const scale = maxDiff > 0 ? maxOnset / maxDiff : 0;

  for (let i = 0; i < out.data.length; i++) {
    out.data[i] = Math.max(onsets.data[i], diff.data[i] * scale);
  }
  return out;
}

/** Local maxima down the time axis, as (row, col) pairs. */
export function localMaxima(m: Matrix): { r: number; c: number }[] {
  const peaks: { r: number; c: number }[] = [];
  for (let r = 1; r < m.rows - 1; r++) {
    for (let c = 0; c < m.cols; c++) {
      const v = at(m, r, c);
      if (v > at(m, r - 1, c) && v > at(m, r + 1, c)) peaks.push({ r, c });
    }
  }
  return peaks;
}

/**
 * Frames + onsets -> notes.
 *
 * Walks onset peaks from the END of the track backwards, following each one forward while
 * its pitch still has energy, then subtracting that energy so a later pass cannot claim
 * the same note twice. That ordering is basic-pitch's own and it matters: taking them
 * forwards makes overlapping notes of the same pitch swallow each other.
 */
export function notesFromOutputs(frames: Matrix, onsetsIn: Matrix, opts: BpOptions = {}): BpNote[] {
  const onsetThreshold = opts.onsetThreshold ?? 0.5;
  const frameThreshold = opts.frameThreshold ?? 0.3;
  const energyTol = opts.energyTolerance ?? 11;
  const minLenFrames = Math.round(((opts.minNoteLength ?? 127.7) / 1000) * ANNOTATIONS_FPS);

  // Work on copies: both are modified.
  const f: Matrix = { data: Float32Array.from(frames.data), rows: frames.rows, cols: frames.cols };
  let o: Matrix = { data: Float32Array.from(onsetsIn.data), rows: onsetsIn.rows, cols: onsetsIn.cols };
  constrainFrequency(o, f, opts.minFreqHz ?? null, opts.maxFreqHz ?? null);
  if (opts.inferOnsets !== false) o = inferredOnsets(o, f);

  const peaks = localMaxima(o).filter((p) => at(o, p.r, p.c) >= onsetThreshold);
  // Latest onsets first.
  peaks.sort((a, b) => b.r - a.r || b.c - a.c);

  const remaining: Matrix = { data: Float32Array.from(f.data), rows: f.rows, cols: f.cols };
  const nFrames = f.rows;
  const notes: BpNote[] = [];

  for (const { r: startIdx, c: pitchIdx } of peaks) {
    if (startIdx >= nFrames - 1) continue;

    let i = startIdx + 1;
    let quiet = 0;
    while (i < nFrames - 1 && quiet < energyTol) {
      quiet = at(remaining, i, pitchIdx) < frameThreshold ? quiet + 1 : 0;
      i++;
    }
    i -= quiet; // back up over the silence that ended it
    if (i - startIdx <= minLenFrames) continue;

    let sum = 0;
    for (let j = startIdx; j < i; j++) {
      sum += at(f, j, pitchIdx);
      // Claim this pitch and its neighbours so harmonic smear cannot become a second note.
      set(remaining, j, pitchIdx, 0);
      if (pitchIdx + 1 < f.cols) set(remaining, j, pitchIdx + 1, 0);
      if (pitchIdx > 0) set(remaining, j, pitchIdx - 1, 0);
    }

    notes.push({
      start: startIdx / ANNOTATIONS_FPS,
      end: i / ANNOTATIONS_FPS,
      pitch: pitchIdx + MIDI_OFFSET,
      amplitude: sum / Math.max(1, i - startIdx),
    });
  }

  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return notes;
}

/**
 * Stitch per-window model output into one matrix for the whole track.
 *
 * Each window overlaps its neighbours by 30 frames, so half of that is dropped from each
 * end — otherwise every boundary produces a duplicate onset.
 */
export function unwrapWindows(windows: Float32Array[], cols: number, audioSamples: number): Matrix {
  const trim = Math.floor(BP_N_OVERLAPPING_FRAMES / 2);
  const kept = BP_FRAMES_PER_WINDOW - 2 * trim;
  const totalRows = Math.floor((audioSamples * ANNOTATIONS_FPS) / BP_SAMPLE_RATE);
  const rows = Math.min(totalRows, windows.length * kept);
  const data = new Float32Array(rows * cols);

  let row = 0;
  for (const w of windows) {
    for (let r = trim; r < BP_FRAMES_PER_WINDOW - trim && row < rows; r++, row++) {
      data.set(w.subarray(r * cols, (r + 1) * cols), row * cols);
    }
  }
  return { data, rows, cols };
}

/** Pad and slice a mono 22.05 kHz signal into the windows the model expects. */
export function windowsFor(mono: Float32Array): Float32Array[] {
  const pad = Math.floor(BP_OVERLAP_LEN / 2);
  const padded = new Float32Array(pad + mono.length);
  padded.set(mono, pad);

  const out: Float32Array[] = [];
  for (let start = 0; start < padded.length; start += BP_HOP_SIZE) {
    const w = new Float32Array(BP_N_SAMPLES);
    const n = Math.min(BP_N_SAMPLES, padded.length - start);
    w.set(padded.subarray(start, start + n));
    out.push(w);
    if (start + BP_N_SAMPLES >= padded.length) break;
  }
  return out;
}
