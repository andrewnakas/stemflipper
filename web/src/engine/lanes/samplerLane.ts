/** Plays the extracted samples: drum kits and pitched multisamples.
 *
 * Zones are chosen by pitch and velocity, round robins cycle, and loop points let a held
 * key sustain instead of stopping when the sample runs out.
 *
 * As with the synth lane, a note's whole shape is scheduled when the note is scheduled: a
 * couple of milliseconds of attack (a multisample sliced out of a mix does not start at a zero
 * crossing, and stepping straight to full level clicks), and the note-end fade for sustained
 * zones. Voices stay in the map until they are actually silent, which is what lets a transport
 * stop or a seek cut them.
 */

import { decodeAudio } from "../../api/assets";
import type { DrumKit, Instrument, Multisample, Note, SampleZone } from "../../model/types";
import { CUT_S, cutParam, disconnectWhenDone, FLOOR } from "./envelope";

/** Enough to be inaudible, enough to kill the step onto a non-zero first sample. */
const ATTACK_S = 0.003;
/** Note-end fade for a sustained (looped) zone. */
const RELEASE_S = 0.03;
/** Sample voices are cheap, but not free; dense kits can still pile up. */
const MAX_VOICES = 48;

interface SampleVoice {
  src: AudioBufferSourceNode;
  gain: GainNode;
  endsAt: number;
}

export class SamplerLane {
  private buffers = new Map<string, AudioBuffer>();
  private rrCounters = new Map<string, number>();
  private playing = new Map<string, SampleVoice>();
  private ready = false;

  constructor(
    private ctx: BaseAudioContext,
    private dest: AudioNode,
    private instrument: Instrument | null,
    private resolve: (rel: string) => string,
  ) {}

  get loaded(): boolean {
    return this.ready;
  }

  get voiceCount(): number {
    return this.playing.size;
  }

  get zoneCount(): number {
    if (!this.instrument) return 0;
    if (this.instrument.type === "drumkit") {
      return Object.values(this.instrument.pieces).reduce((n, p) => n + p.zones.length, 0);
    }
    return this.instrument.zones.length;
  }

  /** Decode every zone up front: mid-playback decoding would drop notes. */
  async load(): Promise<void> {
    if (!this.instrument) return;
    const zones = this.allZones();
    await Promise.all(
      zones.map(async (z) => {
        if (this.buffers.has(z.path)) return;
        try {
          const buf = await decodeAudio(this.ctx, this.resolve(z.path), { mono: false });
          this.buffers.set(z.path, buf);
        } catch {
          /* a missing sample just leaves that zone silent */
        }
      }),
    );
    this.ready = this.buffers.size > 0;
  }

  private allZones(): SampleZone[] {
    if (!this.instrument) return [];
    if (this.instrument.type === "drumkit") {
      return Object.values((this.instrument as DrumKit).pieces).flatMap((p) => p.zones);
    }
    return (this.instrument as Multisample).zones;
  }

  private pickZone(note: Note): { zone: SampleZone; root: number } | null {
    if (!this.instrument) return null;
    if (this.instrument.type === "drumkit") {
      const kit = this.instrument as DrumKit;
      let best: { zone: SampleZone; root: number } | null = null;
      for (const piece of Object.values(kit.pieces)) {
        const matches = (piece.gm_all || [piece.gm]).includes(note.pitch);
        if (!matches && piece.gm !== note.pitch) continue;
        const candidates = piece.zones.filter((z) => note.vel >= z.lovel && note.vel <= z.hivel);
        const pool = candidates.length ? candidates : piece.zones;
        if (!pool.length) continue;
        const key = `${piece.gm}:${pool[0].lovel}`;
        const i = (this.rrCounters.get(key) || 0) % pool.length;
        this.rrCounters.set(key, i + 1);
        best = { zone: pool[i], root: piece.gm };
        break;
      }
      return best;
    }
    const ms = this.instrument as Multisample;
    const inRange = ms.zones.filter(
      (z) => note.pitch >= (z.lo ?? 0) && note.pitch <= (z.hi ?? 127),
    );
    const byVel = inRange.filter((z) => note.vel >= z.lovel && note.vel <= z.hivel);
    const pool = byVel.length ? byVel : inRange.length ? inRange : ms.zones;
    if (!pool.length) return null;
    // nearest root keeps the pitch shift small
    const zone = pool.reduce((a, b) =>
      Math.abs((a.root ?? 60) - note.pitch) <= Math.abs((b.root ?? 60) - note.pitch) ? a : b,
    );
    return { zone, root: zone.root ?? note.pitch };
  }

  noteOn(note: Note, when: number, until: number): void {
    this.prune();
    const picked = this.pickZone(note);
    if (!picked) return;
    const buf = this.buffers.get(picked.zone.path);
    if (!buf) return;
    this.enforceCeiling();
    const existing = this.playing.get(note.id);
    if (existing) this.cut(note.id, Math.max(this.ctx.currentTime, Math.min(when, existing.endsAt)));

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const isKit = this.instrument?.type === "drumkit";
    if (!isKit) {
      src.playbackRate.value = Math.pow(2, (note.pitch - picked.root) / 12);
    }
    const loop = picked.zone.loop;
    const sustained = !!loop && !isKit;
    if (sustained) {
      src.loop = true;
      src.loopStart = loop!.start / buf.sampleRate;
      src.loopEnd = loop!.end / buf.sampleRate;
    }

    const gain = this.ctx.createGain();
    const level = Math.max(0.05, note.vel / 127) * Math.pow(10, (picked.zone.gain_db || 0) / 20);
    // A short attack rather than a step onto whatever the first sample happens to be.
    gain.gain.setValueAtTime(FLOOR, when);
    gain.gain.linearRampToValueAtTime(level, when + ATTACK_S);
    src.connect(gain).connect(this.dest);
    src.start(when);

    let endsAt: number;
    if (sustained) {
      // Held zones are faded out at the note's end, scheduled here so a later call is not
      // needed — which is what keeps this voice in the map and therefore cuttable.
      const rel = Math.max(until, when + ATTACK_S + 0.005);
      gain.gain.setValueAtTime(level, rel);
      gain.gain.exponentialRampToValueAtTime(FLOOR, rel + RELEASE_S);
      endsAt = rel + RELEASE_S + 0.02;
      src.stop(endsAt);
    } else {
      // One-shots ring out for their natural length.
      endsAt = when + buf.duration / (src.playbackRate.value || 1) + 0.05;
      src.stop(endsAt);
    }

    disconnectWhenDone([src], [gain]);
    this.playing.set(note.id, { src, gain, endsAt });
  }

  /** Stop one note now — it was deleted or edited while playing. */
  cut(id: string, at: number): void {
    const v = this.playing.get(id);
    if (!v) return;
    this.playing.delete(id);
    const t = Math.max(at, this.ctx.currentTime);
    cutParam(v.gain.gain, t);
    try {
      v.src.stop(t + CUT_S + 0.01);
    } catch {
      /* already stopped */
    }
  }

  /** Stop everything now: transport stop, seek, or a loop wrap. */
  cutAll(at: number): void {
    for (const id of [...this.playing.keys()]) this.cut(id, at);
  }

  private prune(): void {
    const now = this.ctx.currentTime;
    for (const [id, v] of this.playing) {
      if (v.endsAt <= now) this.playing.delete(id);
    }
  }

  private enforceCeiling(): void {
    if (this.playing.size < MAX_VOICES) return;
    const now = this.ctx.currentTime;
    for (const id of [...this.playing.keys()]) {
      if (this.playing.size < MAX_VOICES) break;
      this.cut(id, now);
    }
  }
}
