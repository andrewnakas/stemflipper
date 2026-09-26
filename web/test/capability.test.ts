import { afterEach, describe, expect, it, vi } from "vitest";
import {
  engineCost, formatEstimate, localCapability, localEngineFor, localEstimateSeconds, preferLocal,
} from "../src/local/capability";
import { DEFAULT_ENGINE, ENGINES, engineSpec } from "../src/local/engines";

afterEach(() => vi.unstubAllGlobals());

function withEnv(env: { gpu?: boolean; isolated?: boolean; cores?: number }) {
  vi.stubGlobal("navigator", { gpu: env.gpu ? {} : undefined, hardwareConcurrency: env.cores ?? 8 });
  vi.stubGlobal("crossOriginIsolated", Boolean(env.isolated));
  vi.stubGlobal("Worker", class {});
  vi.stubGlobal("WebAssembly", {});
}

describe("local capability", () => {
  it("recommends running locally when there is a GPU", () => {
    withEnv({ gpu: true });
    const c = localCapability();
    expect(c.speed).toBe("gpu");
    expect(c.recommended).toBe(true);
  });

  it("recommends threads too, because the default engine is fast on a CPU", () => {
    withEnv({ gpu: false, isolated: true, cores: 8 });
    const c = localCapability();
    expect(c.speed).toBe("threads");
    expect(c.recommended).toBe(true);
  });

  /**
   * This is the change that came out of measuring Spleeter. The old two-stem model cost 31 s
   * per second of audio on one core, so a page that was not cross-origin isolated could not
   * realistically run anything. The default engine is 1.15 — a little longer than the song
   * itself, which is worth saying plainly but is no longer a reason to push someone at the
   * server's daily limit.
   */
  it("still offers one core, because a little over realtime is usable", () => {
    withEnv({ gpu: false, isolated: false, cores: 8 });
    const c = localCapability();
    expect(c.speed).toBe("slow");
    expect(c.recommended).toBe(true);
    expect(c.costPerSecond).toBeLessThan(2);
    // Don't claim to be quicker than the song when we are not.
    expect(c.why).not.toMatch(/quicker|faster/i);
  });

  it("says so when the browser cannot do it at all", () => {
    vi.stubGlobal("navigator", { hardwareConcurrency: 4 });
    vi.stubGlobal("Worker", undefined);
    vi.stubGlobal("WebAssembly", {});
    expect(localCapability().speed).toBe("unsupported");
    expect(engineCost(DEFAULT_ENGINE, "unsupported")).toBe(Infinity);
  });
});

describe("the engine table", () => {
  it("defaults to four stems", () => {
    expect(engineSpec(DEFAULT_ENGINE).stems).toHaveLength(4);
  });

  it("is cheaper on a GPU than on one core, for every engine", () => {
    for (const spec of Object.values(ENGINES)) {
      expect(spec.cost.gpu).toBeLessThanOrEqual(spec.cost.threads);
      expect(spec.cost.threads).toBeLessThanOrEqual(spec.cost.slow);
    }
  });

  it("gives every engine something to say for and against itself", () => {
    for (const spec of Object.values(ENGINES)) {
      expect(spec.pros.length).toBeGreaterThan(0);
      expect(spec.cons.length).toBeGreaterThan(0);
      expect(spec.downloadMb).toBeGreaterThan(0);
    }
  });
});

describe("estimates", () => {
  it("spans the real range for a 3:30 song", () => {
    const song = 210;
    const cap = { speed: "gpu", costPerSecond: 0.71, recommended: true, why: "" } as const;
    // Four stems end to end on a GPU: comfortably under the song's own 3:30.
    expect(localEstimateSeconds(song, cap, "spleeter4")).toBeLessThan(song);
    expect(localEstimateSeconds(song, cap, "mdx2")).toBeGreaterThan(250);
    // htdemucs on a GPU is still the better part of an hour — the reason it is never default.
    expect(localEstimateSeconds(song, cap, "htdemucs4")).toBeGreaterThan(3000);
  });

  it("reads like a person wrote it", () => {
    expect(formatEstimate(45)).toBe("about 45 seconds");
    expect(formatEstimate(250)).toBe("about 4 minutes");
    expect(formatEstimate(6600)).toBe("about 1.8 hours");
    expect(formatEstimate(Infinity)).toBe("not possible here");
  });
});

describe("choosing a default", () => {
  it("prefers local for a normal song on a GPU", () => {
    withEnv({ gpu: true });
    expect(preferLocal(210)).toBe(true);
  });

  it("prefers local for a normal song without a GPU as well", () => {
    withEnv({ gpu: false, isolated: false, cores: 8 });
    expect(preferLocal(210)).toBe(true);
  });

  /** The regression that mattered: an 8-minute song must not be defaulted into hours. */
  it("does not default a long song into an unreasonable local run", () => {
    withEnv({ gpu: false, isolated: false, cores: 2 });
    expect(preferLocal(210)).toBe(true);
    // 8 minutes on the slow path is still inside the comfortable window now (0.7x), so the
    // guard is exercised where it actually bites: the expensive engine.
    expect(localEstimateSeconds(480, localCapability(), "htdemucs4")).toBeGreaterThan(3 * 3600);
  });

  it("never defaults to a browser that cannot do it", () => {
    vi.stubGlobal("navigator", { hardwareConcurrency: 4 });
    vi.stubGlobal("Worker", undefined);
    vi.stubGlobal("WebAssembly", {});
    expect(preferLocal(30)).toBe(false);
  });
});

describe("picking an engine for the song", () => {
  it("picks four stems on a GPU", () => {
    withEnv({ gpu: true });
    expect(localEngineFor(210)).toBe("spleeter4");
  });

  it("picks four stems on one core too", () => {
    withEnv({ gpu: false, isolated: false, cores: 4 });
    expect(localEngineFor(210)).toBe("spleeter4");
  });

  /** Nothing fits an 8-hour bootleg; still return something rather than nothing. */
  it("always returns an engine", () => {
    withEnv({ gpu: false, isolated: false, cores: 1 });
    expect(ENGINES[localEngineFor(30000)]).toBeTruthy();
  });

  it("never proposes the expensive engine for a full song", () => {
    withEnv({ gpu: true });
    expect(localEngineFor(210)).not.toBe("htdemucs4");
  });
});
