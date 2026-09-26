/**
 * Can this device do the work, which engine should it use, and how long will it take?
 *
 * All three have to be answered BEFORE someone commits, because the spread is enormous and
 * it is the difference between a pleasant minute and an abandoned hour. Every cost below
 * lives in `engines.ts` and was measured, not guessed — `web/scripts/local_bench.mjs`
 * prints the table.
 *
 * The shape of the problem changed when Spleeter became the default. The old two-stem model
 * cost 1.1 s per second of audio on a GPU and 31 without one, so a device without WebGPU
 * effectively could not run anything, and the only fix was COOP/COEP headers from the host
 * to unlock threads. The default engine is 0.71 end to end on a GPU and 1.15 on a single
 * core — so cross-origin isolation is now worth about 20%, rather than being the thing
 * standing between most visitors and a local run.
 *
 * Note what those numbers include: transcribing four stems is a bigger share of a local run
 * than separating them. On one core a run takes a little LONGER than the song itself, which
 * is why the copy below says "about as long as the song" there and not "quicker" — it was
 * briefly wrong about this, on the strength of a separation-only measurement.
 */

import { DEFAULT_ENGINE, ENGINE_IDS, engineSpec, type LocalEngine } from "./engines";

export type LocalSpeed = "gpu" | "threads" | "slow" | "unsupported";

export interface LocalCapability {
  speed: LocalSpeed;
  /** Wall-clock seconds of work per second of audio, for the DEFAULT engine. */
  costPerSecond: number;
  /** True when running locally is a reasonable default for this device. */
  recommended: boolean;
  why: string;
}

/** Beyond this, a local run is something to choose deliberately, not to be defaulted into. */
export const MAX_COMFORTABLE_S = 15 * 60;

/** Wall-clock seconds per second of audio for one engine on this device class. */
export function engineCost(engine: LocalEngine, speed: LocalSpeed): number {
  if (speed === "unsupported") return Infinity;
  return engineSpec(engine).cost[speed];
}

export function localCapability(): LocalCapability {
  if (typeof Worker === "undefined" || typeof WebAssembly === "undefined") {
    return { speed: "unsupported", costPerSecond: Infinity, recommended: false, why: "This browser cannot run the models." };
  }
  if ((navigator as { gpu?: unknown }).gpu) {
    return {
      speed: "gpu",
      costPerSecond: engineCost(DEFAULT_ENGINE, "gpu"),
      recommended: true,
      why: "Your graphics card can run the models, so this takes about two thirds of the song's own length.",
    };
  }
  if (typeof crossOriginIsolated !== "undefined" && crossOriginIsolated && (navigator.hardwareConcurrency || 1) > 2) {
    return {
      speed: "threads",
      costPerSecond: engineCost(DEFAULT_ENGINE, "threads"),
      recommended: true,
      why: "Your browser will use several CPU cores — roughly the song's own length.",
    };
  }
  return {
    speed: "slow",
    costPerSecond: engineCost(DEFAULT_ENGINE, "slow"),
    // The default engine on one core is 1.15x realtime — slower than a GPU, but nowhere near
    // a reason to push someone at the server and its daily limit.
    recommended: true,
    why: "This page can only use one CPU core here, so expect a little longer than the song itself.",
  };
}

/** Rough wall-clock seconds for a song of this length on a given engine, incl. start-up. */
export function localEstimateSeconds(
  durationS: number,
  cap = localCapability(),
  engine: LocalEngine = DEFAULT_ENGINE,
): number {
  const cost = engineCost(engine, cap.speed);
  if (!Number.isFinite(cost)) return Infinity;
  return Math.round(15 + durationS * cost);
}

/**
 * Should running locally be the default for THIS song on THIS device?
 *
 * Capability alone is not enough: a 30-second clip is fine even on one CPU core, while an
 * 8-minute song on the slow engine without a GPU is hours. Both were offered as the default
 * before this guard existed.
 */
export function preferLocal(durationS: number, cap = localCapability()): boolean {
  if (cap.speed === "unsupported") return false;
  return cap.recommended && localEstimateSeconds(durationS, cap) <= MAX_COMFORTABLE_S;
}

/**
 * The best engine for this song on this device: the most stems we can give someone without
 * pushing them past the comfortable wait. Falls back to the cheapest if nothing fits, so
 * the picker always has a sensible starting point.
 */
export function localEngineFor(durationS: number, cap = localCapability()): LocalEngine {
  if (cap.speed === "unsupported") return DEFAULT_ENGINE;
  const fits = ENGINE_IDS.filter(
    (id) => localEstimateSeconds(durationS, cap, id) <= MAX_COMFORTABLE_S,
  );
  const pool = fits.length ? fits : [...ENGINE_IDS];
  // Most stems first, then cheapest — so four stems beat two whenever both fit.
  pool.sort((a, b) => {
    const sa = engineSpec(a).stems.length;
    const sb = engineSpec(b).stems.length;
    if (sa !== sb) return sb - sa;
    return engineCost(a, cap.speed) - engineCost(b, cap.speed);
  });
  return pool[0];
}

export function formatEstimate(seconds: number): string {
  if (!Number.isFinite(seconds)) return "not possible here";
  if (seconds < 90) return `about ${Math.round(seconds)} seconds`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `about ${m} minute${m === 1 ? "" : "s"}`;
  const h = seconds / 3600;
  return `about ${h.toFixed(h < 2 ? 1 : 0)} hours`;
}
