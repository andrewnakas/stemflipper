/** Plays the extracted samples: drum kits and pitched multisamples.
 *
 * Zones are chosen by pitch and velocity, round robins cycle, and loop points let a held
 * key sustain instead of stopping when the sample runs out.
 */

import { decodeAudio } from "../../api/assets";
import type { DrumKit, Instrument, Multisample, Note, SampleZone } from "../../model/types";

export class SamplerLane {
  private buffers = new Map<string, AudioBuffer>();
  private rrCounters = new Map<string, number>();
  private playing = new Map<string, { src: AudioBufferSourceNode; gain: GainNode }>();
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
    const picked = this.pickZone(note);
    if (!picked) return;
    const buf = this.buffers.get(picked.zone.path);
    if (!buf) return;

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const isKit = this.instrument?.type === "drumkit";
    if (!isKit) {
      src.playbackRate.value = Math.pow(2, (note.pitch - picked.root) / 12);
    }
    const loop = picked.zone.loop;
    if (loop && !isKit) {
      src.loop = true;
      src.loopStart = loop.start / buf.sampleRate;
      src.loopEnd = loop.end / buf.sampleRate;
    }

    const gain = this.ctx.createGain();
    const level = Math.max(0.05, note.vel / 127) * Math.pow(10, (picked.zone.gain_db || 0) / 20);
    gain.gain.value = level;
    src.connect(gain).connect(this.dest);
    src.start(when);
    // one-shots ring out; sustained zones are cut at note end by noteOff
    if (isKit || !loop) src.stop(when + buf.duration / (src.playbackRate.value || 1) + 0.05);
    else src.stop(until + 0.4);

    this.playing.set(note.id, { src, gain });
  }

  noteOff(id: string, when: number): void {
    const v = this.playing.get(id);
    if (!v) return;
    this.playing.delete(id);
    if (this.instrument?.type === "drumkit") return; // let one-shots decay
    try {
      v.gain.gain.cancelScheduledValues(when);
      v.gain.gain.setValueAtTime(Math.max(0.0001, v.gain.gain.value), when);
      v.gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.03);
      v.src.stop(when + 0.06);
    } catch {
      /* already stopped */
    }
  }

  releaseAll(when: number): void {
    for (const id of [...this.playing.keys()]) this.noteOff(id, when);
  }
}
