import { afterEach, describe, expect, it, vi } from "vitest";
import { formatEstimate, localCapability, localEstimateSeconds, preferLocal } from "../src/local/capability";

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

  it("allows but does not recommend threads", () => {
    withEnv({ gpu: false, isolated: true, cores: 8 });
    const c = localCapability();
    expect(c.speed).toBe("threads");
    expect(c.recommended).toBe(false);
  });

  it("is honest that one core is very slow", () => {
    // Without COOP/COEP the page is not cross-origin isolated, so no threads — the same
    // browser is fast or slow purely by where the page is served from.
    withEnv({ gpu: false, isolated: false, cores: 8 });
    const c = localCapability();
    expect(c.speed).toBe("slow");
    expect(c.recommended).toBe(false);
  });

  it("says so when the browser cannot do it at all", () => {
    vi.stubGlobal("navigator", { hardwareConcurrency: 4 });
    vi.stubGlobal("Worker", undefined);
    vi.stubGlobal("WebAssembly", {});
    expect(localCapability().speed).toBe("unsupported");
  });
});

describe("estimates", () => {
  it("spans the real range for a 3:30 song", () => {
    const song = 210;
    const gpu = localEstimateSeconds(song, { speed: "gpu", costPerSecond: 1.1, recommended: true, why: "" });
    const threads = localEstimateSeconds(song, { speed: "threads", costPerSecond: 10, recommended: false, why: "" });
    const slow = localEstimateSeconds(song, { speed: "slow", costPerSecond: 31, recommended: false, why: "" });
    expect(gpu).toBeLessThan(300);
    expect(threads).toBeGreaterThan(1800);
    expect(slow).toBeGreaterThan(6000);
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

  it("does not default an 8-minute song into a four-hour local run", () => {
    withEnv({ gpu: false, isolated: false, cores: 8 });
    expect(localEstimateSeconds(480)).toBeGreaterThan(3 * 3600);
    expect(preferLocal(480)).toBe(false);
  });

  it("does not default to local even for a short clip when there is no GPU", () => {
    // It is still offered — just not chosen for someone who did not ask.
    withEnv({ gpu: false, isolated: true, cores: 8 });
    expect(preferLocal(20)).toBe(false);
  });

  it("never defaults to a browser that cannot do it", () => {
    vi.stubGlobal("navigator", { hardwareConcurrency: 4 });
    vi.stubGlobal("Worker", undefined);
    vi.stubGlobal("WebAssembly", {});
    expect(preferLocal(30)).toBe(false);
  });
});
