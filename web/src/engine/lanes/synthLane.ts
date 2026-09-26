/** Subtractive synth voices driven by the transcribed notes.
 *
 * Uses the fitted patch.json when the backend produced one; otherwise a sensible default
 * per track kind. Drums get purpose-built percussion voices rather than an oscillator.
 *
 * Two rules keep this quiet, and both used to be broken:
 *
 * 1. **A note's whole envelope is scheduled when the note is scheduled.** Nothing reads
 *    `param.value` to find out where a curve is, because notes are scheduled ahead of the
 *    clock and `.value` is the value NOW — see `envelope.ts` for the pop that caused.
 * 2. **There is a voice ceiling.** Transcribed MIDI is dense (a four-minute `other` stem here
 *    ran to 1,161 notes), and at six nodes a voice an unbounded lane will happily build
 *    hundreds of simultaneous oscillators, which reads as crackle and limiter pumping rather
 *    than as "too many notes". Oldest voice wins.
 */

import type { Note, Patch } from "../../model/types";
import { CUT_S, cutParam, disconnectWhenDone, FLOOR, scheduleAdsr } from "./envelope";

const DEFAULT_PATCH: Patch = {
  type: "subtractive",
  mono: false,
  gain: 0.5,
  glide_s: 0,
  oscillators: [
    { wave: "saw", level: 0.7, detune_cents: -6, octave: 0 },
    { wave: "saw", level: 0.5, detune_cents: 6, octave: 0 },
  ],
  unison: { voices: 1, detune_cents: 0 },
  filter: { type: "lowpass", cutoff_hz: 1800, q: 1.0, env_amount_hz: 2600, key_track: 0.3 },
  filter_env: { a: 0.005, d: 0.12, s: 0.35, r: 0.2 },
  amp_env: { a: 0.008, d: 0.06, s: 0.8, r: 0.12 },
};

const OSC_TYPE: Record<string, OscillatorType> = {
  saw: "sawtooth",
  square: "square",
  triangle: "triangle",
  sine: "sine",
};

/**
 * Voice ceilings. Pitched voices cost ~6 nodes each; drum voices are cheaper and shorter, so
 * they get a higher one. Both are well above anything musical and exist to stop a dense
 * passage from taking the audio thread down with it.
 */
const MAX_PITCHED_VOICES = 24;
const MAX_DRUM_VOICES = 40;

let sharedNoise: { ctx: BaseAudioContext; buf: AudioBuffer } | null = null;

/**
 * Two seconds of noise, looped.
 *
 * It used to be half a second and un-looped, while the crash voice asks for 1.4 s and the ride
 * for 0.9 — so every cymbal ran out of source while its envelope was still at about -34 dB and
 * cut off abruptly. Looping makes the length a non-issue.
 */
function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  if (sharedNoise && sharedNoise.ctx === ctx) return sharedNoise.buf;
  const len = Math.floor(ctx.sampleRate * 2);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  sharedNoise = { ctx, buf };
  return buf;
}

export function midiToHz(pitch: number): number {
  return 440 * Math.pow(2, (pitch - 69) / 12);
}

export interface Voice {
  /** Context time at which this voice is silent and its nodes are gone. */
  endsAt: number;
  /** Stop now, with a short fade: a transport stop, a seek, a deleted note, a stolen voice. */
  cut(at: number): void;
  nodes: AudioNode[];
}

export class SynthLane {
  private voices = new Map<string, Voice>();

  constructor(
    private ctx: BaseAudioContext,
    private dest: AudioNode,
    private patch: Patch | null,
    private isDrum: boolean,
  ) {}

  setPatch(patch: Patch | null): void {
    this.patch = patch;
  }

  /** How many voices are live right now — the smoke test and the tests assert on this. */
  get voiceCount(): number {
    return this.voices.size;
  }

  /**
   * Schedule a note in full: attack, decay, sustain and release all in one pass.
   *
   * `until` is the note's end, so no later call is needed to release it — which is what makes
   * `cutAll` meaningful, since the voice stays in the map until it is actually silent.
   */
  noteOn(note: Note, when: number, until: number): void {
    this.prune();
    this.enforceCeiling();
    // A repeated id (a loop pass over the same note) must not orphan the first voice.
    const existing = this.voices.get(note.id);
    if (existing) existing.cut(Math.max(this.ctx.currentTime, Math.min(when, existing.endsAt)));

    const voice = this.isDrum
      ? this.drumVoice(note, when)
      : this.pitchedVoice(note, when, until);
    if (voice) this.voices.set(note.id, voice);
  }

  /** Stop one note now — it was deleted or edited while playing. */
  cut(id: string, at: number): void {
    const v = this.voices.get(id);
    if (!v) return;
    v.cut(at);
    this.voices.delete(id);
  }

  /** Stop everything now: transport stop, seek, or a loop wrap. */
  cutAll(at: number): void {
    for (const [id, v] of this.voices) {
      v.cut(at);
      this.voices.delete(id);
    }
  }

  /** Drop voices that have already finished, so the ceiling counts only live ones. */
  private prune(): void {
    const now = this.ctx.currentTime;
    for (const [id, v] of this.voices) {
      if (v.endsAt <= now) this.voices.delete(id);
    }
  }

  private enforceCeiling(): void {
    const max = this.isDrum ? MAX_DRUM_VOICES : MAX_PITCHED_VOICES;
    if (this.voices.size < max) return;
    // A Map iterates in insertion order, so the first key is the oldest voice.
    const now = this.ctx.currentTime;
    for (const [id, v] of this.voices) {
      if (this.voices.size < max) break;
      v.cut(now);
      this.voices.delete(id);
    }
  }

  private pitchedVoice(note: Note, when: number, until: number): Voice {
    const p = this.patch || DEFAULT_PATCH;
    const ctx = this.ctx;
    const vv = Math.max(0.05, note.vel / 127);
    const freq = midiToHz(note.pitch);

    const amp = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = p.filter.type || "lowpass";
    filter.Q.value = p.filter.q;
    filter.connect(amp);
    amp.connect(this.dest);

    // filter envelope: brighter attack settling to the patch cutoff, harder notes brighter
    const base = Math.min(ctx.sampleRate / 2 - 200, Math.max(120, p.filter.cutoff_hz + p.filter.key_track * freq));
    const peak = Math.min(ctx.sampleRate / 2 - 200, base + p.filter.env_amount_hz * vv);
    filter.frequency.setValueAtTime(peak, when);
    filter.frequency.exponentialRampToValueAtTime(
      Math.max(60, base),
      when + Math.max(0.01, p.filter_env.d),
    );

    const level = vv * p.gain;
    const endsAt = scheduleAdsr(amp.gain, when, until, level, p.amp_env);

    const sources: (OscillatorNode | AudioBufferSourceNode)[] = [];
    const unison = Math.max(1, Math.min(4, p.unison.voices));
    const active = p.oscillators.filter((o) => o.level > 0);
    for (const osc of active) {
      for (let u = 0; u < unison; u++) {
        const spread = unison > 1 ? (u - (unison - 1) / 2) * p.unison.detune_cents : 0;
        const g = ctx.createGain();
        g.gain.value = osc.level / (Math.max(1, active.length) * unison);
        if (osc.wave === "noise") {
          const src = ctx.createBufferSource();
          src.buffer = noiseBuffer(ctx);
          src.loop = true;
          g.gain.value *= 0.25;
          src.connect(g).connect(filter);
          src.start(when);
          src.stop(endsAt + 0.02);
          sources.push(src);
          continue;
        }
        const src = ctx.createOscillator();
        src.type = OSC_TYPE[osc.wave] || "sawtooth";
        src.frequency.value = freq * Math.pow(2, osc.octave);
        src.detune.value = osc.detune_cents + spread;
        src.connect(g).connect(filter);
        src.start(when);
        src.stop(endsAt + 0.02);
        sources.push(src);
      }
    }

    const nodes: AudioNode[] = [filter, amp];
    disconnectWhenDone(sources, nodes);

    return {
      endsAt: endsAt + 0.02,
      nodes: [...sources, ...nodes],
      cut: (t: number) => {
        const at = Math.max(t, this.ctx.currentTime);
        cutParam(amp.gain, at);
        for (const s of sources) {
          try {
            s.stop(at + CUT_S + 0.01);
          } catch {
            /* already stopped */
          }
        }
      },
    };
  }

  /** Kick / snare / hat / tom / cymbal voices by GM pitch. */
  private drumVoice(note: Note, when: number): Voice {
    const ctx = this.ctx;
    const vv = Math.max(0.05, note.vel / 127);
    const out = ctx.createGain();
    out.gain.value = 1;
    out.connect(this.dest);
    const nodes: AudioNode[] = [out];
    const sources: (OscillatorNode | AudioBufferSourceNode)[] = [];
    const p = note.pitch;
    let longest = 0;

    const noise = (dur: number, hp: number, gain: number, type: BiquadFilterType = "highpass", q = 1) => {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(ctx);
      // Looped, so a 1.4 s crash is not cut short by the length of the noise table.
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = hp;
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(Math.max(FLOOR, gain * vv), when);
      g.gain.exponentialRampToValueAtTime(FLOOR, when + dur);
      src.connect(f).connect(g).connect(out);
      src.start(when);
      src.stop(when + dur + 0.02);
      nodes.push(f, g);
      sources.push(src);
      longest = Math.max(longest, dur + 0.02);
    };
    const body = (f0: number, f1: number, dur: number, gain: number, type: OscillatorType = "sine") => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(f0, when);
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), when + dur * 0.9);
      const g = ctx.createGain();
      g.gain.setValueAtTime(Math.max(FLOOR, gain * vv), when);
      g.gain.exponentialRampToValueAtTime(FLOOR, when + dur);
      osc.connect(g).connect(out);
      osc.start(when);
      osc.stop(when + dur + 0.02);
      nodes.push(g);
      sources.push(osc);
      longest = Math.max(longest, dur + 0.02);
    };

    if (p <= 37) {
      body(150, 48, 0.28 + 0.2 * vv, 0.9);
      noise(0.02, 1800, 0.25);
    } else if (p === 38 || p === 39 || p === 40) {
      noise(0.14 + 0.08 * vv, 1800, 0.7, "bandpass", 0.8);
      body(190, 160, 0.11, 0.35, "triangle");
    } else if (p >= 41 && p <= 50 && p !== 42 && p !== 44 && p !== 46 && p !== 49) {
      body(p >= 47 ? 260 : 160, p >= 47 ? 150 : 90, 0.32, 0.75, "sine");
      noise(0.03, 900, 0.15);
    } else if (p === 42 || p === 44) {
      noise(0.045 + 0.03 * vv, 7000, 0.45);
    } else if (p === 46) {
      noise(0.28 + 0.15 * vv, 6500, 0.4);
    } else if (p === 51 || p === 53 || p === 59) {
      noise(0.9, 5200, 0.28, "highpass", 0.5);
      body(520, 480, 0.5, 0.08, "triangle");
    } else {
      noise(1.4, 3800, 0.36, "highpass", 0.4); // crash and friends
    }

    disconnectWhenDone(sources, nodes);

    return {
      endsAt: when + longest,
      nodes: [...sources, ...nodes],
      // A percussion voice rings out past the note's end by design — but a transport stop or a
      // seek must still silence it, which is what this is for.
      cut: (t: number) => {
        const at = Math.max(t, this.ctx.currentTime);
        cutParam(out.gain, at);
        for (const s of sources) {
          try {
            s.stop(at + CUT_S + 0.01);
          } catch {
            /* already stopped */
          }
        }
      },
    };
  }
}
