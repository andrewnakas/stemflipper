/**
 * The transport's clock and its loop.
 *
 * Driven with a fake context and a captured timer so ticks happen exactly where the test wants
 * them, which is the only way to catch the two loop bugs pinned here: notes dropped at the end
 * of every pass, and a playhead that ran backwards across the wrap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Transport, type TrackRuntime } from "../src/engine/transport";
import type { Note } from "../src/model/types";
import { asCtx, FakeContext } from "./fakeAudio";

/** Records what the lanes were asked to play, so the test can assert on scheduling. */
class SpyLane {
  ons: { id: string; when: number; until: number }[] = [];
  cuts = 0;
  noteOn(note: Note, when: number, until: number) {
    this.ons.push({ id: note.id, when, until });
  }
  cut() {
    this.cuts++;
  }
  cutAll() {
    this.cuts++;
  }
  startAt() {}
  stop() {}
}

/** One spy per lane, so a note is not counted twice. `spy` is the synth's. */
function runtime(notes: Note[]): TrackRuntime & { spy: SpyLane } {
  const synth = new SpyLane();
  return {
    id: "t",
    notes,
    audio: new SpyLane() as never,
    synth: synth as never,
    sampler: new SpyLane() as never,
    cursor: 0,
    sounding: new Map(),
    spy: synth,
  };
}

function notesEvery(n: number, step: number, dur = 0.1): Note[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `n${i}`,
    pitch: 60,
    start: +(i * step).toFixed(6),
    end: +(i * step + dur).toFixed(6),
    vel: 100,
    conf: 1,
  }));
}

let ticks: (() => void)[] = [];

beforeEach(() => {
  ticks = [];
  vi.stubGlobal("window", {
    setInterval: (fn: () => void) => {
      ticks.push(fn);
      return ticks.length;
    },
    clearInterval: () => undefined,
  });
  vi.stubGlobal("performance", { now: () => 0 });
});
afterEach(() => vi.unstubAllGlobals());

/** Advance the context clock and run the scheduler, the way the real timer would. */
function advance(ctx: FakeContext, _t: Transport, to: number, stepS = 0.025) {
  while (ctx.currentTime < to) {
    ctx.currentTime = Math.min(to, ctx.currentTime + stepS);
    for (const fn of ticks) fn();
  }
}

describe("looping", () => {
  it("plays every note in the loop, including the ones just before the wrap", () => {
    const ctx = new FakeContext();
    const t = new Transport(asCtx(ctx));
    // A note every 100 ms, and a loop that ends between two of them.
    const r = runtime(notesEvery(40, 0.1));
    t.duration = 4;
    t.setTracks([r]);
    t.setLoop(0, 1);
    t.play(0);
    advance(ctx, t, 2.5);

    // Every note inside 0..1 should have been scheduled at least once. The bug returned early
    // on the wrap tick, so notes between the previous horizon and the loop point were skipped
    // once per pass — a hole at the end of every loop.
    const played = new Set(r.spy.ons.map((o) => o.id));
    for (let i = 0; i < 10; i++) {
      expect(played.has(`n${i}`), `note n${i} (t=${(i * 0.1).toFixed(1)}) never played`).toBe(true);
    }
  });

  it("never runs the playhead backwards", () => {
    const ctx = new FakeContext();
    const t = new Transport(asCtx(ctx));
    t.duration = 4;
    t.setTracks([runtime(notesEvery(40, 0.1))]);
    t.setLoop(0, 1);
    t.play(0);

    let prev = -1;
    let wraps = 0;
    while (ctx.currentTime < 3) {
      ctx.currentTime += 0.01;
      for (const fn of ticks) fn();
      const at = t.now();
      if (at < prev) wraps++; // a wrap is the one legitimate step back
      else expect(at).toBeGreaterThanOrEqual(prev);
      prev = at;
      expect(at).toBeGreaterThanOrEqual(0);
    }
    expect(wraps).toBeGreaterThan(0); // it did actually loop
  });

  it("stays inside the loop", () => {
    const ctx = new FakeContext();
    const t = new Transport(asCtx(ctx));
    t.duration = 10;
    t.setTracks([runtime(notesEvery(100, 0.1))]);
    t.setLoop(1, 2);
    t.play(1);
    advance(ctx, t, 6, 0.01);
    expect(t.now()).toBeLessThanOrEqual(2.2);
    expect(t.now()).toBeGreaterThanOrEqual(0.9);
  });
});

describe("late ticks", () => {
  /**
   * The scheduler shares the main thread with the canvases, and a background tab throttles its
   * timer to about 1 Hz. With a fixed horizon those notes landed in the past, were clamped to
   * "now", and all fired at once — a missed beat turned into a cluster.
   */
  it("does not fire a burst of notes after a long stall", () => {
    const ctx = new FakeContext();
    const t = new Transport(asCtx(ctx));
    const r = runtime(notesEvery(60, 0.05));
    t.duration = 10;
    t.setTracks([r]);
    t.play(0);
    // One tick, then a full second of nothing, then ticks resume.
    ctx.currentTime = 0.1;
    for (const fn of ticks) fn();
    r.spy.ons.length = 0; // only interested in what the tick AFTER the stall does
    ctx.currentTime = 1.2;
    for (const fn of ticks) fn();

    // Nothing may be scheduled behind the clock: a note clamped to "now" is a flam.
    for (const o of r.spy.ons) {
      expect(o.when).toBeGreaterThanOrEqual(ctx.currentTime - 0.001);
    }
    // And they must not all land on the same instant.
    const at = r.spy.ons.map((o) => +o.when.toFixed(3));
    expect(new Set(at).size).toBe(at.length);
    // And the notes it did miss are counted rather than crammed in.
    expect(t.dropped).toBeGreaterThan(0);
  });

  it("widens its look-ahead when ticks are slow", () => {
    const ctx = new FakeContext();
    const t = new Transport(asCtx(ctx));
    const r = runtime(notesEvery(60, 0.05));
    t.duration = 10;
    let wall = 0;
    vi.stubGlobal("performance", { now: () => wall * 1000 });
    t.setTracks([r]);
    t.play(0);

    // Ticks arriving every 400 ms: the horizon must stretch to cover them or every gap
    // between ticks becomes a hole in the music.
    for (let i = 0; i < 6; i++) {
      wall += 0.4;
      ctx.currentTime += 0.4;
      for (const fn of ticks) fn();
    }
    const scheduledAhead = r.spy.ons.filter((o) => o.when > ctx.currentTime + 0.2).length;
    expect(scheduledAhead).toBeGreaterThan(0);
  });
});

describe("stopping", () => {
  it("cuts the lanes so nothing rings on", () => {
    const ctx = new FakeContext();
    const t = new Transport(asCtx(ctx));
    const r = runtime(notesEvery(20, 0.1, 3));
    t.duration = 5;
    t.setTracks([r]);
    t.play(0);
    advance(ctx, t, 0.5);
    const before = r.spy.cuts;
    t.stop();
    expect(r.spy.cuts).toBeGreaterThan(before);
  });

  it("sounds a note that is already held when you seek into it", () => {
    const ctx = new FakeContext();
    const t = new Transport(asCtx(ctx));
    // One long note covering the whole span.
    const r = runtime([{ id: "pad", pitch: 60, start: 0, end: 8, vel: 100, conf: 1 }]);
    t.duration = 8;
    t.setTracks([r]);
    t.play(0);
    advance(ctx, t, 0.2);
    r.spy.ons.length = 0;
    t.seek(4);
    // The old code aimed the cursor at the first note STARTING after the seek, so a held pad
    // went silent until the next note began while the stem carried on without it.
    expect(r.spy.ons.map((o) => o.id)).toContain("pad");
  });
});
