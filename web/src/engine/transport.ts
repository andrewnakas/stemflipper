/** The transport: one clock, a look-ahead scheduler, and every lane in sync.
 *
 * v1 scheduled every note of every stem up front and tore the whole graph down on any
 * mute, solo, seek or loop wrap. This schedules a rolling 150 ms window, so edits and
 * mixer moves take effect without rebuilding anything, and a loop wraps by rebasing the
 * clock rather than restarting the world.
 */

import type { Note } from "../model/types";
import { AudioLane } from "./lanes/audioLane";
import { SamplerLane } from "./lanes/samplerLane";
import { SynthLane } from "./lanes/synthLane";

const TICK_MS = 25;
const HORIZON_S = 0.15;
const START_DELAY_S = 0.06;

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

  private baseSong = 0;
  private baseCtx = 0;
  private pausedAt = 0;
  private timer: number | null = null;
  private wrapScheduled = false;
  private tracks: TrackRuntime[] = [];

  constructor(private ctx: BaseAudioContext) {}

  setTracks(tracks: TrackRuntime[]): void {
    this.tracks = tracks;
  }

  /** Current song position in seconds. */
  now(): number {
    if (!this.playing) return this.pausedAt;
    return this.baseSong + (this.ctx.currentTime - this.baseCtx);
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

  play(from?: number): void {
    const start = from ?? this.pausedAt;
    const at = this.ctx.currentTime + START_DELAY_S;
    this.rebase(start, at);
    this.resetCursors(start);
    this.wrapScheduled = false;
    for (const t of this.tracks) t.audio.startAt(at, start);
    this.playing = true;
    this.startTimer();
  }

  stop(): void {
    const at = this.ctx.currentTime;
    this.pausedAt = this.now();
    this.playing = false;
    this.stopTimer();
    for (const t of this.tracks) {
      t.audio.stop(at);
      t.synth.releaseAll(at);
      t.sampler.releaseAll(at);
      t.sounding.clear();
    }
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
    for (const tr of this.tracks) {
      tr.synth.releaseAll(this.ctx.currentTime);
      tr.sampler.releaseAll(this.ctx.currentTime);
    }
    this.rebase(target, at);
    this.resetCursors(target);
    this.wrapScheduled = false;
    for (const tr of this.tracks) tr.audio.startAt(at, target);
  }

  nudge(delta: number): void {
    this.seek(this.now() + delta);
  }

  /** Notes changed (an edit, or a track reloaded): re-aim the cursors, drop dead voices. */
  notesChanged(): void {
    const song = this.now();
    for (const t of this.tracks) {
      t.cursor = lowerBound(t.notes, song);
      const live = new Set(t.notes.map((n) => n.id));
      for (const id of [...t.sounding.keys()]) {
        if (!live.has(id)) {
          t.synth.noteOff(id, this.ctx.currentTime);
          t.sampler.noteOff(id, this.ctx.currentTime);
          t.sounding.delete(id);
        }
      }
    }
  }

  setLoop(a: number, b: number): void {
    const lo = Math.max(0, Math.min(a, b));
    const hi = Math.min(this.duration, Math.max(a, b));
    this.loop = { a: lo, b: hi, on: hi - lo > 0.05 };
    this.wrapScheduled = false;
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
    const song = this.now();
    const horizon = song + HORIZON_S;

    if (this.loop.on && !this.wrapScheduled && horizon >= this.loop.b) {
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
    for (const t of this.tracks) {
      while (t.cursor < t.notes.length && t.notes[t.cursor].start < horizon) {
        const note = t.notes[t.cursor++];
        if (note.end <= song) continue;
        const when = Math.max(this.ctxTimeFor(note.start), this.ctx.currentTime);
        const until = Math.max(this.ctxTimeFor(note.end), when + 0.02);
        t.synth.noteOn(note, when, until);
        t.sampler.noteOn(note, when, until);
        t.sounding.set(note.id, until);
        t.synth.noteOff(note.id, until);
        t.sampler.noteOff(note.id, until);
      }
    }
  }

  /** Wrap the loop by rebasing the clock at the wrap point, not by restarting. */
  private wrapAt(from: number, to: number): void {
    const at = this.ctxTimeFor(from);
    this.wrapScheduled = true;
    for (const t of this.tracks) {
      t.synth.releaseAll(at);
      t.sampler.releaseAll(at);
      t.audio.startAt(at, to);
    }
    this.rebase(to, at);
    this.resetCursors(to);
    window.setTimeout(() => {
      this.wrapScheduled = false;
    }, Math.max(10, (at - this.ctx.currentTime) * 1000));
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
