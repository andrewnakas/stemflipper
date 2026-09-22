/**
 * ZeroGPU budgeting, mirrored from the server.
 *
 * The Space asks ZeroGPU for a duration up front, and ZeroGPU refuses the job outright if
 * that duration is longer than the caller's remaining daily quota — *before* running
 * anything. So the browser has to do the same arithmetic the server does, or a visitor
 * uploads 30 MB only to be told no. estimateGpuSeconds is a line-for-line mirror of
 * stemflipper/neural.py::estimate_gpu_seconds and test/quota.test.ts pins it to the
 * Python's own output.
 */

import { DAILY_QUOTA_S, GPU_COST, GPU_FIXED_S, GPU_SIX_EXTRA, type Preset, type Tier } from "../config";

/** The duration the Space will request from ZeroGPU for this song. */
export function estimateGpuSeconds(durationS: number, preset: Preset = "balanced", six = false): number {
  const minutes = Math.max(0.25, Math.min(durationS / 60, 8));
  const perMin = (GPU_COST[preset] ?? GPU_COST.balanced) + (six ? GPU_SIX_EXTRA : 0);
  return Math.trunc(Math.max(30, Math.min(GPU_FIXED_S + perMin * minutes, 240)));
}

/**
 * Roughly how long the run takes in wall-clock seconds, which is what the progress bar
 * needs. Anchored on live runs of the 16 s fixture (fast 26 s, balanced 58 s) — these are
 * estimates for pacing a bar, never shown as a promise. Re-measured in N7.
 */
const WALL_FIXED: Record<Preset, number> = { fast: 22, balanced: 50, best: 60 };
const WALL_PER_MIN: Record<Preset, number> = { fast: 15, balanced: 30, best: 45 };

export function estimateWallSeconds(durationS: number, preset: Preset = "balanced", six = false): number {
  const minutes = Math.max(0.25, Math.min(durationS / 60, 8));
  return Math.round(WALL_FIXED[preset] + (WALL_PER_MIN[preset] + (six ? 8 : 0)) * minutes);
}

export function dailyBudgetS(tier: Tier): number {
  return DAILY_QUOTA_S[tier];
}

/** How many songs of this length a full day's quota buys. */
export function songsPerDay(tier: Tier, preset: Preset, durationS: number, six = false): number {
  const each = estimateGpuSeconds(durationS, preset, six);
  return Math.max(0, Math.floor(dailyBudgetS(tier) / each));
}

/** Would this preset even be allowed to start on a full day's quota? */
export function fitsBudget(tier: Tier, preset: Preset, durationS: number, six = false): boolean {
  return estimateGpuSeconds(durationS, preset, six) <= dailyBudgetS(tier);
}

/**
 * The preset we pick for someone who has not chosen.
 *
 * Signed in, quality first. Anonymous, still quality first — balanced fits a 2-minute
 * daily budget for any song we accept — but a song long enough that balanced would eat
 * the whole day drops to fast, so they get more than one try.
 */
export function pickPreset(durationS: number, tier: Tier): Preset {
  if (tier === "anonymous") {
    return estimateGpuSeconds(durationS, "balanced") <= 100 ? "balanced" : "fast";
  }
  return "balanced";
}

export function formatSeconds(s: number): string {
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  return rest ? `${m} min ${rest} s` : `${m} min`;
}

/** "2 hours 13 minutes" for a retry countdown. */
export function formatWait(s: number): string {
  if (s < 90) return `${Math.round(s)} seconds`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (!h) return `${m} minute${m === 1 ? "" : "s"}`;
  return m ? `${h} hour${h === 1 ? "" : "s"} ${m} min` : `${h} hour${h === 1 ? "" : "s"}`;
}

export const PRESET_INFO: Record<Preset, { label: string; blurb: string }> = {
  fast: { label: "Fast", blurb: "One model. Good stems, quickest result." },
  balanced: { label: "Balanced", blurb: "Vocal model, then stems, then the drum kit split into its pieces." },
  best: { label: "Best", blurb: "Same chain with the slower, more accurate stem model." },
};
