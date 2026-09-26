/** The transport: one clock, a look-ahead scheduler, and every lane in sync.
 *
 * v1 scheduled every note of every stem up front and tore the whole graph down on any
 * mute, solo, seek or loop wrap. This schedules a rolling window, so edits and mixer moves
 * take effect without rebuilding anything, and a loop wraps by rebasing the clock rather
 * than restarting the world.
 *
 * Three things about the scheduling are load-bearing:
 *
 * - **A note is handed to a lane once.** `noteOn` gets both `when` and `until` and schedules
 *   the whole envelope, release included. The old code called `noteOff` on the very next line,
 *   which deleted the voice from the lane's map immediately — so the maps were always empty and
 *   stop, seek and loop-wrap silenced nothing at all. Notes rang on over the top of whatever
 *   came next.
 * - **The horizon grows if the main thread is busy.** This is a `setInterval` on the same
 *   thread as the canvases, and a background tab throttles it to about 1 Hz. A fixed 150 ms
 *   horizon meant a stalled frame scheduled notes in the past, where they were clamped to "now"
 *   and all fired together. The horizon now tracks the interval actually being achieved.
 * - **A note too far in the past is dropped, not flammed.** Clamping a badly late note to the
 *   present turns a missed beat into a cluster, which is worse than the missed beat.
 */

import type { Note } from "../model/types";
import { AudioLane } from "./lanes/audioLane";
import { SamplerLane } from "./lanes/samplerLane";
import { SynthLane } from "./lanes/synthLane";

const TICK_MS = 25;
/** Floor for the look-ahead; the real horizon also covers the tick rate being achieved. */
const HORIZON_S = 0.18;
const MAX_HORIZON_S = 1.5;
const START_DELAY_S = 0.06;
/** Later than this and the note is in the past: play it and it is a flam, so skip it. */
const LATE_TOLERANCE_S = 0.035;
/**
 * How far back to look for notes already sounding when playback starts mid-song. Notes are
 * ordered by start, so finding one that straddles the start point means scanning backwards;
 * ten seconds covers any sustained pad without making the scan unbounded.
 */
const HELD_LOOKBACK_S = 10;

export interface TrackRuntime {
  id: string;
  notes: Note[];
  audio: AudioLane;
  synth: SynthLane;
  sampler: SamplerLane;
  cursor: number;
  /** ids of notes scheduled to sound, with the context time they end */
  sounding: Map<string, number>;
}

export class Transport {
  playing = false;
  duration = 0;
  loop: { a: number; b: number; on: boolean } = { a: 0, b: 0, on: false };
  /** Notes dropped for being too late to play honestly. Surfaced for debugging. */
  dropped = 0;

  private baseSong = 0;
  private baseCtx = 0;
  private pausedAt = 0;
  private timer: number | null = null;
  private tracks: TrackRuntime[] = [];
  private lastTickAt = 0;
  private tickGap = TICK_MS / 1000;

  constructor(private ctx: BaseAudioContext) {}

  setTracks(tracks: TrackRuntime[]): void {
    this.tracks = tracks;
  }

  /** Current song position in seconds. */
  now(): number {
    if (!this.playing) return this.pausedAt;
    // Clamped at the base: immediately after a wrap the clock is rebased to a point slightly
    // in the future, and without this the playhead would run backwards until it caught up.
    return this.baseSong + Math.max(0, this.ctx.currentTime - this.baseCtx);
  }

  private ctxTimeFor(song: number): number {
    return this.baseCtx + (song - this.baseSong);
  }

  private rebase(song: number, at: number): void {
    this.baseSong = song;
    this.baseCtx = at;
  }

  private resetCursors(from: number): void {
    for (const t of this.tracks) {
      t.cursor = lowerBound(t.notes, from);
      t.sounding.clear();
    }
  }

  /**
   * Sound the remainder of any note that is already in progress at `song`.
   *
   * `resetCursors` aims at the first note starting at or after the position, so without this a
   * seek into the middle of a held bass note or pad left the synth and sampler silent until the
   * next note began — while the original stem carried on, which sounds like a dropout.
   */
  private scheduleHeld(song: number, at: number): void {
    for (const t of this.tracks) {
      for (let i = t.cursor - 1; i >= 0; i--) {
        const n = t.notes[i];
        if (song - n.start > HELD_LOOKBACK_S) break;
        if (n.end <= song + 0.02) continue;
        const until = at + (n.end - song);
        t.synth.noteOn(n, at, until);
        t.sampler.noteOn(n, at, until);
        t.sounding.set(n.id, until);
      }
    }
  }

  private cutAll(at: number): void {
    for (const t of this.tracks) {
      t.synth.cutAll(at);
      t.sampler.cutAll(at);
      t.sounding.clear();
    }
  }

  /** The look-ahead to use, given how well the timer is actually keeping up. */
  private horizon(): number {
    return Math.min(MAX_HORIZON_S, Math.max(HORIZON_S, this.tickGap * 3));
  }

  play(from?: number): void {
    const start = from ?? this.pausedAt;
    const at = this.ctx.currentTime + START_DELAY_S;
    this.rebase(start, at);
    this.resetCursors(start);
    if (start > 0) this.scheduleHeld(start, at);
    for (const t of this.tracks) t.audio.startAt(at, start);
    this.playing = true;
    this.tickGap = TICK_MS / 1000;
    this.lastTickAt = 0;
    this.startTimer();
  }

  stop(): void {
    const at = this.ctx.currentTime;
    this.pausedAt = this.now();
    this.playing = false;
    this.stopTimer();
    for (const t of this.tracks) t.audio.stop(at + 0.006);
    this.cutAll(at);
  }

  toggle(): void {
    if (this.playing) this.stop();
    else this.play(this.pausedAt >= this.duration - 0.05 ? 0 : this.pausedAt);
  }

  seek(t: number): void {
    const target = Math.max(0, Math.min(t, this.duration));
    if (!this.playing) {
      this.pausedAt = target;
      return;
    }
    const at = this.ctx.currentTime + 0.03;
    this.cutAll(this.ctx.currentTime);
    this.rebase(target, at);
    this.resetCursors(target);
    this.scheduleHeld(target, at);
    for (const tr of this.tracks) tr.audio.startAt(at, target);
  }

  nudge(delta: number): void {
    this.seek(this.now() + delta);
  }

  /** Notes changed (an edit, or a track reloaded): re-aim the cursors, drop dead voices. */
  notesChanged(): void {
    const song = this.now();
    const at = this.ctx.currentTime;
    for (const t of this.tracks) {
      t.cursor = lowerBound(t.notes, song);
      const live = new Set(t.notes.map((n) => n.id));
      for (const id of [...t.sounding.keys()]) {
        if (!live.has(id)) {
          t.synth.cut(id, at);
          t.sampler.cut(id, at);
          t.sounding.delete(id);
        }
      }
    }
  }

  setLoop(a: number, b: number): void {
    const lo = Math.max(0, Math.min(a, b));
    const hi = Math.min(this.duration, Math.max(a, b));
    this.loop = { a: lo, b: hi, on: hi - lo > 0.05 };
  }

  clearLoop(): void {
    this.loop = { a: 0, b: 0, on: false };
  }

  private startTimer(): void {
    this.stopTimer();
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    if (!this.playing) return;

    // Track the interval actually being achieved, so the horizon can cover it.
    const wall = typeof performance !== "undefined" ? performance.now() / 1000 : Date.now() / 1000;
    if (this.lastTickAt) {
      const gap = wall - this.lastTickAt;
      // Rise fast, fall slowly: one long frame should widen the window immediately, and it
      // should narrow again only once things have genuinely settled.
      this.tickGap = gap > this.tickGap ? gap : this.tickGap * 0.9 + gap * 0.1;
    }
    this.lastTickAt = wall;

    const song = this.now();
    const horizon = song + this.horizon();

    if (this.loop.on && horizon >= this.loop.b) {
      // Schedule up to the loop point FIRST — returning here used to drop every note between
      // the previous horizon and the end of the loop, once per pass.
      this.scheduleWindow(song, this.loop.b);
      this.wrapAt(this.loop.b, this.loop.a);
      return;
    }
    if (!this.loop.on && song >= this.duration) {
      this.stop();
      this.pausedAt = this.duration;
      return;
    }
    this.scheduleWindow(song, horizon);
  }

  private scheduleWindow(song: number, horizon: number): void {
    const now = this.ctx.currentTime;
    for (const t of this.tracks) {
      while (t.cursor < t.notes.length && t.notes[t.cursor].start < horizon) {
        const note = t.notes[t.cursor++];
        if (note.end <= song) continue;
        const ideal = this.ctxTimeFor(note.start);
        if (ideal < now - LATE_TOLERANCE_S) {
          this.dropped++;
          continue;
        }
        const when = Math.max(ideal, now);
        const until = Math.max(this.ctxTimeFor(note.end), when + 0.02);
        t.synth.noteOn(note, when, until);
        t.sampler.noteOn(note, when, until);
        t.sounding.set(note.id, until);
      }
    }
  }

  /** Wrap the loop by rebasing the clock at the wrap point, not by restarting. */
  private wrapAt(from: number, to: number): void {
    const at = this.ctxTimeFor(from);
    for (const t of this.tracks) {
      t.synth.cutAll(at);
      t.sampler.cutAll(at);
      t.sounding.clear();
      t.audio.startAt(at, to);
    }
    this.rebase(to, at);
    this.resetCursors(to);
  }

  dispose(): void {
    this.stopTimer();
    this.playing = false;
  }
}

/** First index whose note starts at or after `t`. */
export function lowerBound(notes: Note[], t: number): number {
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].start < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
