/**
 * Space liveness.
 *
 * A ZeroGPU Space sleeps after 48 h idle (gcTimeout 172800) and takes a minute or two to
 * come back. Without this the first visitor of the day just sees an upload that hangs.
 * The Hub's API is CORS-open (verified: it echoes the site origin), so the page can ask
 * directly rather than inferring a stall.
 */

export type SpaceStage =
  | "RUNNING"
  | "RUNNING_BUILDING"
  | "RUNNING_APP_STARTING"
  | "SLEEPING"
  | "BUILDING"
  | "APP_STARTING"
  | "PAUSED"
  | "STOPPED"
  | "BUILD_ERROR"
  | "RUNTIME_ERROR"
  | "UNKNOWN";

export interface SpaceStatus {
  stage: SpaceStage;
  /** true when a request would be served right now. */
  awake: boolean;
  /** true when waiting will fix it (asleep or starting), false when it is broken. */
  willWake: boolean;
  hardware: string | null;
}

const WAKING: SpaceStage[] = ["SLEEPING", "BUILDING", "APP_STARTING", "RUNNING_BUILDING", "RUNNING_APP_STARTING"];
const BROKEN: SpaceStage[] = ["PAUSED", "STOPPED", "BUILD_ERROR", "RUNTIME_ERROR"];

/** Only a hosted Space can sleep; `python app.py` on localhost is always awake. */
export function isHostedSpace(baseUrl: string): boolean {
  return /^https?:\/\/[a-z0-9-]+\.hf\.space/i.test(baseUrl);
}

export async function fetchSpaceStatus(spaceId: string, signal?: AbortSignal): Promise<SpaceStatus> {
  const res = await fetch(`https://huggingface.co/api/spaces/${spaceId}`, { credentials: "omit", signal });
  if (!res.ok) throw new Error(`space status failed (${res.status})`);
  const body = (await res.json()) as { runtime?: { stage?: string; hardware?: { current?: string } } };
  const stage = (body.runtime?.stage || "UNKNOWN") as SpaceStage;
  return {
    stage,
    awake: stage === "RUNNING",
    willWake: WAKING.includes(stage) || (!BROKEN.includes(stage) && stage !== "RUNNING"),
    hardware: body.runtime?.hardware?.current ?? null,
  };
}

/**
 * Nudge a sleeping Space awake. Fire-and-forget: the request itself is what starts the
 * container, and we do not care about the response.
 */
export function wakePing(baseUrl: string): void {
  fetch(baseUrl.replace(/\/+$/, "") + "/", { credentials: "omit", mode: "no-cors" }).catch(() => undefined);
}

/** Poll until the Space is serving, or give up. Resolves true if it woke. */
export async function waitUntilAwake(
  spaceId: string,
  opts: { timeoutMs?: number; onStage?: (s: SpaceStage) => void; signal?: AbortSignal } = {},
): Promise<boolean> {
  const deadline = Date.now() + (opts.timeoutMs ?? 240_000);
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) return false;
    try {
      const status = await fetchSpaceStatus(spaceId, opts.signal);
      opts.onStage?.(status.stage);
      if (status.awake) return true;
      if (!status.willWake) return false;
    } catch {
      // Hub hiccup: keep waiting rather than failing the whole run.
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  return false;
}
