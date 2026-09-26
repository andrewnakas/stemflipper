/**
 * The sampler and the "original" stem lane.
 *
 * Both used to click for the same reason in different clothing: a level applied as a step
 * rather than a ramp, and a splice made by disconnecting a node while its stop was still
 * scheduled in the future.
 */
import { describe, expect, it } from "vitest";
import { AudioLane } from "../src/engine/lanes/audioLane";
import { SamplerLane } from "../src/engine/lanes/samplerLane";
import type { Instrument, Note } from "../src/model/types";
import { asCtx, FakeBuffer, FakeContext } from "./fakeAudio";

function note(over: Partial<Note> = {}): Note {
  return { id: "n1", pitch: 60, start: 1, end: 1.5, vel: 100, conf: 0.9, ...over };
}

/** A one-zone multisample whose buffer is injected, so no network or decode is involved. */
function sampler(ctx: FakeContext, opts: { loop?: boolean } = {}) {
  const inst = {
    type: "multisample",
    name: "test",
    amp_env: { a: 0, d: 0, s: 1, r: 0 },
    zones: [
      {
        path: "samples/a.wav",
        root: 60,
        lo: 0,
        hi: 127,
        lovel: 0,
        hivel: 127,
        rr: 1,
        gain_db: 0,
        loop: opts.loop ? { start: 1000, end: 20000, crossfade: 0 } : null,
      },
    ],
  } as unknown as Instrument;
  const lane = new SamplerLane(asCtx(ctx), ctx.createGain() as never, inst, (r) => r);
  // Inject the decoded buffer directly: load() would fetch.
  (lane as unknown as { buffers: Map<string, unknown> }).buffers.set(
    "samples/a.wav",
    new FakeBuffer(1, ctx.sampleRate * 2, ctx.sampleRate),
  );
  return lane;
}

describe("sampler lane", () => {
  it("ramps in rather than stepping to full level", () => {
    const ctx = new FakeContext();
    ctx.currentTime = 0.5;
    const lane = sampler(ctx);
    lane.noteOn(note(), 1.0, 1.5);

    const g = ctx.gains().find((x) => x.gain.events.length > 0);
    expect(g).toBeTruthy();
    // Silent at the instant the sample starts: a multisample cut out of a mix does not begin
    // at a zero crossing, so stepping straight to level clicks.
    expect(g!.gain.valueAt(1.0)).toBeLessThan(0.01);
    // Up to level a few milliseconds later.
    expect(g!.gain.valueAt(1.01)).toBeGreaterThan(0.5);
  });

  it("keeps a voice until it is silent, so a stop can cut it", () => {
    const ctx = new FakeContext();
    ctx.currentTime = 0.5;
    const lane = sampler(ctx, { loop: true });
    lane.noteOn(note({ end: 5 }), 1.0, 5.0);
    expect(lane.voiceCount).toBe(1);
    ctx.currentTime = 2;
    lane.cutAll(2);
    expect(lane.voiceCount).toBe(0);
    const g = ctx.gains().find((x) => x.gain.events.length > 0);
    expect(g!.gain.valueAt(2.1)).toBeLessThan(0.01);
  });

  it("holds a ceiling on how many samples ring at once", () => {
    const ctx = new FakeContext();
    const lane = sampler(ctx);
    for (let i = 0; i < 200; i++) lane.noteOn(note({ id: `n${i}` }), 0.1, 0.5);
    expect(lane.voiceCount).toBeLessThanOrEqual(48);
  });
});

describe("original stem lane", () => {
  it("fades in and out instead of cutting, so a loop wrap does not click", () => {
    const ctx = new FakeContext();
    ctx.currentTime = 1;
    const buf = new FakeBuffer(1, ctx.sampleRate * 30, ctx.sampleRate);
    const lane = new AudioLane(asCtx(ctx), ctx.createGain() as never, buf as never);

    lane.startAt(2, 0);
    const first = ctx.sources()[0];
    const g1 = ctx.gains().find((x) => x.gain.events.length > 0)!;
    expect(g1.gain.valueAt(2)).toBeLessThan(0.01);
    expect(g1.gain.valueAt(2.02)).toBeGreaterThan(0.9);

    // A loop wrap: the splice is at a future time, and the outgoing source must still be
    // connected up to that point — disconnecting it immediately is what used to leave a gap.
    lane.startAt(5, 0);
    expect(first.disconnected).toBe(0);
    expect(g1.gain.valueAt(5.0001)).toBeLessThan(0.02);
    expect(first.stoppedAt!).toBeGreaterThanOrEqual(5);
  });

  /**
   * If the scheduler is late, playing from the requested offset would leave the stem out of
   * step with the transport clock for the rest of the song.
   */
  it("keeps its place when started late", () => {
    const ctx = new FakeContext();
    ctx.currentTime = 10;
    const buf = new FakeBuffer(1, ctx.sampleRate * 60, ctx.sampleRate);
    const lane = new AudioLane(asCtx(ctx), ctx.createGain() as never, buf as never);
    lane.startAt(9.8, 5); // asked to start 200 ms ago
    const src = ctx.sources()[0];
    expect(src.startedAt).toBe(10);
    expect(src.startOffset).toBeCloseTo(5.2, 5);
  });
});
