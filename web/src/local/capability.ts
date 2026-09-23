/**
 * Can this device do the work, and how long will it take?
 *
 * This has to be answered BEFORE someone commits, because the spread is enormous.
 * Measured on the separation model: WebGPU runs about 1.1 s of wall clock per second of
 * audio, multi-threaded WASM about 10, and single-threaded WASM about 31. The same
 * 3:30 song is four minutes, half an hour, or an hour and three quarters.
 *
 * Threads need the page to be cross-origin isolated, which needs COOP/COEP headers the
 * host must send — so the same browser is fast or slow depending on where the page is
 * served from, and the UI should say so rather than let someone start a two-hour job.
 */

export type LocalSpeed = "gpu" | "threads" | "slow" | "unsupported";

export interface LocalCapability {
  speed: LocalSpeed;
  /** Wall-clock seconds of work per second of audio. */
  costPerSecond: number;
  /** True when running locally is a reasonable default for this device. */
  recommended: boolean;
  why: string;
}

const COST: Record<Exclude<LocalSpeed, "unsupported">, number> = { gpu: 1.1, threads: 10, slow: 31 };

export function localCapability(): LocalCapability {
  if (typeof Worker === "undefined" || typeof WebAssembly === "undefined") {
    return { speed: "unsupported", costPerSecond: Infinity, recommended: false, why: "This browser cannot run the models." };
  }
  if ((navigator as { gpu?: unknown }).gpu) {
    return {
      speed: "gpu",
      costPerSecond: COST.gpu,
      recommended: true,
      why: "Your graphics card can run the model, so this is about as fast as the song is long.",
    };
  }
  if (typeof crossOriginIsolated !== "undefined" && crossOriginIsolated && (navigator.hardwareConcurrency || 1) > 2) {
    return {
      speed: "threads",
      costPerSecond: COST.threads,
      recommended: false,
      why: "Your browser will use several CPU cores. It works, but it is much slower than a graphics card.",
    };
  }
  return {
    speed: "slow",
    costPerSecond: COST.slow,
    recommended: false,
    why: "This page can only use one CPU core here, which makes local processing very slow.",
  };
}

/** Rough wall-clock seconds for a song of this length, including model start-up. */
export function localEstimateSeconds(durationS: number, cap = localCapability()): number {
  if (!Number.isFinite(cap.costPerSecond)) return Infinity;
  return Math.round(15 + durationS * cap.costPerSecond);
}

/**
 * Should running locally be the default for THIS song on THIS device?
 *
 * Capability alone is not enough: a 30-second clip is fine even on one CPU core, while an
 * 8-minute song without a GPU is four hours. Both were offered as the default before this.
 */
export function preferLocal(durationS: number, cap = localCapability()): boolean {
  if (cap.speed === "unsupported") return false;
  return cap.recommended && localEstimateSeconds(durationS, cap) <= MAX_COMFORTABLE_S;
}

/** Beyond this, a local run is something to choose deliberately, not to be defaulted into. */
export const MAX_COMFORTABLE_S = 15 * 60;

export function formatEstimate(seconds: number): string {
  if (!Number.isFinite(seconds)) return "not possible here";
  if (seconds < 90) return `about ${Math.round(seconds)} seconds`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `about ${m} minute${m === 1 ? "" : "s"}`;
  const h = seconds / 3600;
  return `about ${h.toFixed(h < 2 ? 1 : 0)} hours`;
}
