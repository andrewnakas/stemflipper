import { describe, expect, it } from "vitest";
import { beatPhase, buildBeats, chromaOf, estimateKey } from "../src/local/analysis";
import { analyse, onsetEnvelope, toMono } from "../src/local/tempo.js";

const SR = 44100;

/** A click track: an impulse with a short decay every beat, starting at `phase`. */
function clicks(bpm: number, seconds: number, phase = 0): Float32Array {
  const n = seconds * SR;
  const out = new Float32Array(n);
  const step = (60 / bpm) * SR;
  for (let t = phase * SR; t < n; t += step) {
    const i = Math.round(t);
    for (let k = 0; k < 900 && i + k < n; k++) out[i + k] = Math.exp(-k / 120) * (k % 2 ? -0.8 : 0.8);
  }
  return out;
}

/** The shape the copied detector expects — it only uses these fields. */
function asBuffer(data: Float32Array) {
  return {
    numberOfChannels: 1,
    length: data.length,
    duration: data.length / SR,
    sampleRate: SR,
    getChannelData: () => data,
  };
}

describe("tempo, ported from audiosaw's detector", () => {
  for (const bpm of [90, 120, 128, 140]) {
    it(`finds ${bpm} BPM on a click track`, () => {
      const got = analyse(asBuffer(clicks(bpm, 12)));
      // Half/double is a defensible reading of a bare click track, so accept the octave.
      const ratio = got.bpm / bpm;
      const ok = Math.abs(got.bpm - bpm) < 2 || Math.abs(ratio - 2) < 0.05 || Math.abs(ratio - 0.5) < 0.05;
      expect(ok, `got ${got.bpm} for ${bpm}`).toBe(true);
    });
  }
});

describe("beat phase", () => {
  it("lands on the clicks, not between them", () => {
    // A grid with the right spacing and the wrong phase puts every bar line in a gap,
    // which is worse than no grid at all.
    const bpm = 120;
    const offset = 0.17;
    const data = clicks(bpm, 12, offset);
    const env = onsetEnvelope(toMono(asBuffer(data)), SR);
    const phase = beatPhase(env.flux, env.rate, bpm);
    const period = 60 / bpm;
    const err = Math.min((phase - offset + period * 10) % period, (offset - phase + period * 10) % period);
    expect(err).toBeLessThan(0.06);
  });

  it("returns something usable for degenerate input", () => {
    expect(beatPhase(new Float32Array(4), 86, 120)).toBe(0);
    expect(beatPhase(new Float32Array(1000).fill(0), 86, 120)).toBeGreaterThanOrEqual(0);
  });
});

describe("grid", () => {
  it("spaces beats by the tempo and marks every fourth a downbeat", () => {
    const g = buildBeats(120, 0.25, 5);
    expect(g.tempo).toBe(120);
    expect(g.time_signature).toBe("4/4");
    expect(g.source).toBe("browser");
    expect(g.beats[0]).toBeCloseTo(0.25, 3);
    expect(g.beats[1] - g.beats[0]).toBeCloseTo(0.5, 3);
    expect(g.downbeats[1] - g.downbeats[0]).toBeCloseTo(2, 3);
    expect(g.beats[g.beats.length - 1]).toBeLessThan(5);
  });
});

describe("key", () => {
  it("reads a pure tone's pitch class out of the chroma", () => {
    const n = SR * 2;
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = Math.sin((2 * Math.PI * 440 * i) / SR) * 0.5; // A4
    const c = chromaOf(a, SR);
    const peak = c.indexOf(Math.max(...c));
    expect(peak).toBe(9); // A
  });

  it("calls a C major triad C major, and an A minor triad A minor", () => {
    const tri = (semis: number[]) => {
      const c = new Float32Array(12);
      for (const s of semis) c[((s % 12) + 12) % 12] = 1;
      return c;
    };
    expect(estimateKey(tri([0, 4, 7])).name).toBe("C major");
    expect(estimateKey(tri([9, 0, 4])).name).toBe("A minor");
  });

  it("always names a key and never a negative confidence", () => {
    const k = estimateKey(new Float32Array(12).fill(1 / 12));
    expect(k.name).toMatch(/^[A-G]#? (major|minor)$/);
    expect(k.confidence).toBeGreaterThanOrEqual(0);
  });
});
