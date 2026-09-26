/**
 * Clicks, pops and stuck notes in the synth and sampler lanes.
 *
 * A click is a discontinuity in a gain curve, so these tests record the automation the lanes
 * schedule (see fakeAudio.ts) and assert the curve is continuous and never exceeds the level
 * the note asked for. That is a sharper instrument than listening: it names the sample where
 * the jump happens.
 *
 * Every test drives the lane exactly the way `Transport.scheduleWindow` does — noteOn with a
 * future `when`, then the note's end — because the bug these were written for only appears
 * when the scheduling happens ahead of the clock, which is always.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { SynthLane } from "../src/engine/lanes/synthLane";

import type { Note, Patch } from "../src/model/types";
import { asCtx, FakeContext, FakeGain } from "./fakeAudio";

function note(over: Partial<Note> = {}): Note {
  return { id: "n1", pitch: 60, start: 1, end: 1.5, vel: 100, conf: 0.9, ...over };
}

const PATCH: Patch = {
  type: "subtractive",
  mono: false,
  gain: 0.5,
  glide_s: 0,
  oscillators: [{ wave: "saw", level: 0.7, detune_cents: 0, octave: 0 }],
  unison: { voices: 1, detune_cents: 0 },
  filter: { type: "lowpass", cutoff_hz: 1800, q: 1, env_amount_hz: 2600, key_track: 0.3 },
  filter_env: { a: 0.005, d: 0.12, s: 0.35, r: 0.2 },
  amp_env: { a: 0.008, d: 0.06, s: 0.8, r: 0.12 },
} as Patch;

/** The gain node carrying a voice's amplitude envelope: the one with scheduled automation. */
function envelopeGains(ctx: FakeContext): FakeGain[] {
  return ctx.gains().filter((g) => g.gain.events.length > 1);
}

describe("synth voice envelope", () => {
  let ctx: FakeContext;
  let lane: SynthLane;

  beforeEach(() => {
    ctx = new FakeContext();
    ctx.currentTime = 0.5; // scheduling always happens ahead of the clock
    lane = new SynthLane(asCtx(ctx), ctx.createGain() as never, PATCH, false);
  });

  /**
   * The bug this file was written for. `stop()` read `amp.gain.value` to find the level to
   * release from — but `.value` is the value NOW, and the release is scheduled in the FUTURE,
   * so it read the GainNode's default 1.0 and jumped the envelope to full scale at every
   * note-off before ramping down. An audible pop on every single note, in playback and in
   * exported audio alike.
   */
  it("never scheduled louder than the note asked for", () => {
    const n = note();
    lane.noteOn(n, 1.0, 1.5);

    const peakLevel = (n.vel / 127) * PATCH.gain; // ≈ 0.39
    for (const g of envelopeGains(ctx)) {
      // From the note's start: before that the node is at its default 1.0, but nothing is
      // connected to it yet, so it is silent.
      const peak = g.gain.peakBetween(1.0, 2.5);
      expect(peak).toBeLessThanOrEqual(peakLevel * 1.05);
    }
  });

  it("has a continuous envelope from attack to silence", () => {
    const n = note();
    lane.noteOn(n, 1.0, 1.5);

    for (const g of envelopeGains(ctx)) {
      // From the note's start to the end of its release: the span where it makes sound.
      const worst = g.gain.worstJump(1.0, 1.5 + PATCH.amp_env.r + 0.05);
      // A 2x step inside a few samples is a click; a smooth envelope stays near 1.
      expect(worst.ratio).toBeLessThan(2);
    }
  });

  it("starts from silence, so there is no click on note-on", () => {
    const n = note();
    lane.noteOn(n, 1.0, 1.5);
    for (const g of envelopeGains(ctx)) {
      expect(g.gain.valueAt(1.0)).toBeLessThan(0.01);
    }
  });

  it("ends at silence, so there is no click on note-off", () => {
    const n = note();
    lane.noteOn(n, 1.0, 1.5);
    const release = PATCH.amp_env.r;
    for (const g of envelopeGains(ctx)) {
      expect(g.gain.valueAt(1.5 + release + 0.01)).toBeLessThan(0.01);
    }
  });
});

describe("voice ceiling", () => {
  let ctx: FakeContext;
  let lane: SynthLane;

  beforeEach(() => {
    ctx = new FakeContext();
    ctx.currentTime = 0;
    lane = new SynthLane(asCtx(ctx), ctx.createGain() as never, PATCH, false);
  });

  /**
   * Transcribed MIDI is dense — a four-minute "other" stem here came back with 1,161 notes —
   * and at roughly six nodes a voice an unbounded lane will build hundreds of simultaneous
   * oscillators. That does not sound like too many notes, it sounds like crackle, because the
   * audio thread runs out of time. So there is a ceiling.
   */
  it("holds the line on a dense passage", () => {
    for (let i = 0; i < 200; i++) {
      lane.noteOn(note({ id: `n${i}`, pitch: 40 + (i % 40), start: 1, end: 3 }), 1 + i * 0.001, 3);
    }
    expect(lane.voiceCount).toBeLessThanOrEqual(24);
  });

  it("forgets voices once they have finished, so the ceiling counts live ones", () => {
    for (let i = 0; i < 10; i++) {
      lane.noteOn(note({ id: `n${i}`, start: 1, end: 1.2 }), 1, 1.2);
    }
    expect(lane.voiceCount).toBe(10);
    // Well past the release of every one of them.
    ctx.currentTime = 10;
    lane.noteOn(note({ id: "later" }), 10, 10.5);
    expect(lane.voiceCount).toBe(1);
  });

  it("re-triggering the same note id does not orphan the first voice", () => {
    const n = note({ id: "same", start: 1, end: 1.4 });
    lane.noteOn(n, 1, 1.4);
    lane.noteOn(n, 1.5, 1.9);
    expect(lane.voiceCount).toBe(1);
  });
});

describe("stopping and seeking", () => {
  /**
   * The bug: the transport called `noteOff` on the line after `noteOn`, which deleted the voice
   * from the lane's map at scheduling time. The map was therefore always empty, so `releaseAll`
   * on a stop, a seek or a loop wrap silenced nothing and notes rang on over whatever came next.
   */
  it("cutAll silences notes that are still scheduled to sound", () => {
    const ctx = new FakeContext();
    ctx.currentTime = 0.5;
    const lane = new SynthLane(asCtx(ctx), ctx.createGain() as never, PATCH, false);
    lane.noteOn(note({ id: "a", start: 1, end: 4 }), 1.0, 4.0);
    lane.noteOn(note({ id: "b", start: 1.1, end: 4 }), 1.1, 4.0);
    expect(lane.voiceCount).toBe(2);

    ctx.currentTime = 2.0; // mid-note
    lane.cutAll(2.0);
    expect(lane.voiceCount).toBe(0);

    for (const g of envelopeGains(ctx)) {
      // Silent shortly after the cut, rather than carrying on to its scheduled end.
      expect(g.gain.valueAt(2.1)).toBeLessThan(0.01);
    }
  });

  it("cuts drum voices too, which ring out past the note by design", () => {
    const ctx = new FakeContext();
    ctx.currentTime = 0.5;
    const drums = new SynthLane(asCtx(ctx), ctx.createGain() as never, PATCH, true);
    drums.noteOn(note({ id: "crash", pitch: 49, start: 1, end: 1.1 }), 1.0, 1.1);
    ctx.currentTime = 1.2;
    drums.cutAll(1.2);
    expect(drums.voiceCount).toBe(0);
    // The voice's own output gain is taken to silence, so a stop actually stops.
    const out = ctx.gains().filter((g) => g.gain.events.length > 0);
    expect(out.some((g) => g.gain.valueAt(1.3) < 0.01)).toBe(true);
  });
});
