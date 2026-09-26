/**
 * The browser drum transcriber.
 *
 * The classifier is the server's, verbatim (`stemflipper/transcription/drums.py:295-320`):
 * band ratios decide kick vs snare vs hat. The onset detector is not the server's, so these
 * tests pin the behaviour that matters — that hits are found where they were put, and that
 * the band ratios send them to the right General MIDI note.
 */
import { describe, expect, it } from "vitest";
import { transcribeDrums } from "../src/local/drums";

const SR = 22050;
const GM_KICK = 36;
const GM_SNARE = 38;
const GM_HAT = 42;

/** A decaying sine burst: low = kick-shaped, high = hat-shaped. */
function hit(buf: Float32Array, atS: number, freq: number, decayS: number, amp = 0.9) {
  const at = Math.round(atS * SR);
  const n = Math.round(decayS * SR);
  for (let i = 0; i < n && at + i < buf.length; i++) {
    buf[at + i] += amp * Math.exp(-i / (decayS * SR * 0.25)) * Math.sin((2 * Math.PI * freq * i) / SR);
  }
}

/** Broadband noise burst: what a snare looks like to a band-ratio classifier. */
function noiseHit(buf: Float32Array, atS: number, decayS: number, amp = 0.9) {
  const at = Math.round(atS * SR);
  const n = Math.round(decayS * SR);
  let seed = 12345;
  for (let i = 0; i < n && at + i < buf.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const white = (seed / 0x3fffffff) - 1;
    buf[at + i] += amp * Math.exp(-i / (decayS * SR * 0.3)) * white;
  }
}

describe("browser drum transcription", () => {
  /**
   * Four kicks must come back as four notes, not twelve. This is the regression that made
   * the envelope smoothing and the neighbourhood test necessary: at 800 frames a second the
   * RMS of a low sine ripples inside the hit and every ripple looked like another onset.
   */
  it("finds four hits in a four-hit bar, not one per ripple", () => {
    const buf = new Float32Array(SR * 2);
    for (let i = 0; i < 4; i++) hit(buf, 0.25 + i * 0.4, 60, 0.15);
    const notes = transcribeDrums(buf, SR);
    expect(notes).toHaveLength(4);
  });

  it("calls a low thump a kick", () => {
    const buf = new Float32Array(SR * 2);
    for (let i = 0; i < 4; i++) hit(buf, 0.25 + i * 0.4, 55, 0.18);
    const notes = transcribeDrums(buf, SR);
    expect(notes.length).toBeGreaterThan(0);
    for (const n of notes) expect(n.pitch).toBe(GM_KICK);
  });

  it("does not call a low thump a hi-hat", () => {
    const buf = new Float32Array(SR * 2);
    for (let i = 0; i < 4; i++) hit(buf, 0.3 + i * 0.4, 50, 0.2);
    const notes = transcribeDrums(buf, SR);
    expect(notes.some((n) => n.pitch === GM_HAT)).toBe(false);
  });

  it("puts every hit in the General MIDI kit and in time order", () => {
    const buf = new Float32Array(SR * 3);
    hit(buf, 0.2, 55, 0.2);
    noiseHit(buf, 0.7, 0.12);
    hit(buf, 1.2, 55, 0.2);
    hit(buf, 1.7, 9000, 0.03);
    const notes = transcribeDrums(buf, SR);
    expect(notes.length).toBeGreaterThan(0);
    for (const n of notes) {
      expect([GM_KICK, GM_SNARE, GM_HAT]).toContain(n.pitch);
      expect(n.end).toBeGreaterThan(n.start);
      expect(n.amplitude).toBeGreaterThan(0);
      expect(n.amplitude).toBeLessThanOrEqual(1);
    }
    const starts = notes.map((n) => n.start);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  it("finds hits near where they were put", () => {
    const buf = new Float32Array(SR * 2);
    const want = [0.3, 0.8, 1.3];
    for (const t of want) hit(buf, t, 55, 0.18);
    const notes = transcribeDrums(buf, SR);
    for (const t of want) {
      expect(notes.some((n) => Math.abs(n.start - t) < 0.05)).toBe(true);
    }
  });

  it("returns nothing for silence, rather than phantom hits", () => {
    expect(transcribeDrums(new Float32Array(SR), SR)).toEqual([]);
    expect(transcribeDrums(new Float32Array(0), SR)).toEqual([]);
  });
});
