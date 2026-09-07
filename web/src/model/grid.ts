/** Musical time: seconds <-> beats, bars:beats display, snapping.
 *
 * Mirrors stemflipper/analysis/grid.py so the browser and the backend agree on where a
 * beat is, including on songs whose tempo drifts.
 */

import type { Grid } from "./types";

export function beatsPerBar(grid: Grid | null): number {
  const n = parseInt((grid?.time_signature || "4/4").split("/")[0], 10);
  return Number.isFinite(n) && n > 0 ? n : 4;
}

export function secondsToBeats(grid: Grid | null, t: number): number {
  const beats = grid?.beats;
  if (!beats || beats.length < 2) return (t * (grid?.tempo || 120)) / 60;
  if (t <= beats[0]) {
    const step = beats[1] - beats[0];
    return step > 0 ? (t - beats[0]) / step : 0;
  }
  const last = beats.length - 1;
  if (t >= beats[last]) {
    const step = beats[last] - beats[last - 1];
    return step > 0 ? last + (t - beats[last]) / step : last;
  }
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] <= t) lo = mid;
    else hi = mid;
  }
  const span = beats[lo + 1] - beats[lo];
  return span > 0 ? lo + (t - beats[lo]) / span : lo;
}

export function beatsToSeconds(grid: Grid | null, b: number): number {
  const beats = grid?.beats;
  if (!beats || beats.length < 2) return (b * 60) / (grid?.tempo || 120);
  if (b <= 0) return beats[0] + b * (beats[1] - beats[0]);
  const last = beats.length - 1;
  if (b >= last) return beats[last] + (b - last) * (beats[last] - beats[last - 1]);
  const i = Math.floor(b);
  return beats[i] + (b - i) * (beats[i + 1] - beats[i]);
}

/** Snap a time to the nearest grid subdivision. `division` is notes per beat (4 = 16ths). */
export function snapSeconds(grid: Grid | null, t: number, division: number): number {
  if (!division || division <= 0) return t;
  const b = secondsToBeats(grid, t);
  return beatsToSeconds(grid, Math.round(b * division) / division);
}

/** "bar.beat.tick" for the transport clock. */
export function barsBeats(grid: Grid | null, t: number): string {
  const per = beatsPerBar(grid);
  const b = Math.max(0, secondsToBeats(grid, t));
  const bar = Math.floor(b / per) + 1;
  const beat = Math.floor(b % per) + 1;
  const tick = Math.floor((b % 1) * 100);
  return `${bar}.${beat}.${String(tick).padStart(2, "0")}`;
}

export function formatTime(t: number): string {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  const rest = Math.floor(s % 60);
  return `${m}:${String(rest).padStart(2, "0")}`;
}

/** Bar start times covering [0, duration], for drawing the ruler. */
export function barLines(grid: Grid | null, duration: number): number[] {
  if (grid?.downbeats?.length) return grid.downbeats.filter((t) => t <= duration);
  const beats = grid?.beats || [];
  const per = beatsPerBar(grid);
  // the duration filter belongs on EVERY branch: without it the ruler drew bar lines
  // past the end of the song
  if (beats.length) return beats.filter((t, i) => i % per === 0 && t <= duration);
  const step = (60 / (grid?.tempo || 120)) * per;
  const out: number[] = [];
  for (let t = 0; t <= duration; t += step) out.push(t);
  return out;
}
