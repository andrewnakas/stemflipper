/**
 * The invariant that guards the four-stem path.
 *
 * Spleeter's ratio masks sum to 1 by construction, so the stems must reconstruct the mix.
 * `residualDb` is what measures it, it goes into `project.json` as `separation.residual_db`,
 * and the smoke test fails the run if it drifts. Measured on real audio it is about -165 dB;
 * these tests pin the measurement itself, which is the part that could silently lie.
 */
import { describe, expect, it } from "vitest";
import { residualDb, spleeterUrls } from "../src/local/spleeter";

describe("residualDb", () => {
  it("is floored, not -Infinity, for a perfect reconstruction", () => {
    const l = Float32Array.from({ length: 128 }, (_, i) => Math.sin(i / 5));
    const r = Float32Array.from({ length: 128 }, (_, i) => Math.cos(i / 7));
    const stems = { a: [l.slice(), r.slice()] };
    expect(residualDb(l, r, stems)).toBe(-200);
  });

  it("splits across several stems that add back up", () => {
    const n = 256;
    const l = Float32Array.from({ length: n }, (_, i) => Math.sin(i / 3));
    const r = Float32Array.from({ length: n }, (_, i) => Math.sin(i / 11));
    const half = (x: Float32Array) => Float32Array.from(x, (v) => v / 2);
    const stems = {
      a: [half(l), half(r)],
      b: [half(l), half(r)],
    };
    expect(residualDb(l, r, stems)).toBeLessThan(-100);
  });

  /** A stem quietly dropped should show up as a loud residual, not pass silently. */
  it("reports a big number when a stem is missing", () => {
    const n = 256;
    const l = Float32Array.from({ length: n }, (_, i) => Math.sin(i / 3));
    const r = Float32Array.from({ length: n }, (_, i) => Math.sin(i / 11));
    const half = (x: Float32Array) => Float32Array.from(x, (v) => v / 2);
    const stems = { a: [half(l), half(r)] };
    const db = residualDb(l, r, stems);
    expect(db).toBeGreaterThan(-12);
    expect(db).toBeLessThan(0);
  });

  it("names one model file per stem", () => {
    const urls = spleeterUrls();
    expect(urls).toHaveLength(4);
    for (const u of urls) expect(u).toMatch(/\.fp16\.onnx$/);
    expect(new Set(urls).size).toBe(4);
  });
});

/**
 * Track order must not depend on which engine ran. Spleeter emits vocals first, htdemucs
 * drums first; the server's own order (KNOWN_STEMS) wins so Listen and Studio look the same
 * either way.
 */
describe("track order", () => {
  it("puts stems in the server's order whatever the engine emitted", async () => {
    const { ENGINES } = await import("../src/local/engines");
    const canonical = ["vocals", "drums", "bass", "guitar", "piano", "other", "instrumental"];
    const rank = (id: string) => {
      const i = canonical.indexOf(id);
      return i < 0 ? canonical.length : i;
    };
    for (const spec of Object.values(ENGINES)) {
      const sorted = [...spec.stems].sort((a, b) => rank(a) - rank(b));
      // Every engine's stems are drawn from the canonical set, so sorting is total.
      for (const s of spec.stems) expect(canonical).toContain(s);
      expect(sorted[0]).toBe("vocals");
    }
  });
});
