/** Subtractive synth voices driven by the transcribed notes.
 *
 * Uses the fitted patch.json when the backend produced one; otherwise a sensible default
 * per track kind. Drums get purpose-built percussion voices rather than an oscillator.
 */

import type { Note, Patch } from "../../model/types";

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

let sharedNoise: { ctx: BaseAudioContext; buf: AudioBuffer } | null = null;

function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  if (sharedNoise && sharedNoise.ctx === ctx) return sharedNoise.buf;
  const len = Math.floor(ctx.sampleRate * 0.5);
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
  stop(when: number): void;
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

  noteOn(note: Note, when: number, until: number): void {
    const voice = this.isDrum
      ? this.drumVoice(note, when)
      : this.pitchedVoice(note, when, until);
    if (voice) this.voices.set(note.id, voice);
  }

  noteOff(id: string, when: number): void {
    const v = this.voices.get(id);
    if (!v) return;
    v.stop(when);
    this.voices.delete(id);
  }

  releaseAll(when: number): void {
    for (const [id, v] of this.voices) {
      v.stop(when);
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

    const sources: AudioNode[] = [];
    const unison = Math.max(1, Math.min(4, p.unison.voices));
    for (const osc of p.oscillators) {
      if (osc.level <= 0) continue;
      for (let u = 0; u < unison; u++) {
        const spread = unison > 1 ? (u - (unison - 1) / 2) * p.unison.detune_cents : 0;
        if (osc.wave === "noise") {
          const src = ctx.createBufferSource();
          src.buffer = noiseBuffer(ctx);
          src.loop = true;
          const g = ctx.createGain();
          g.gain.value = osc.level * 0.25;
          src.connect(g).connect(filter);
          src.start(when);
          src.stop(until + p.amp_env.r + 0.05);
          sources.push(src);
          continue;
        }
        const src = ctx.createOscillator();
        src.type = OSC_TYPE[osc.wave] || "sawtooth";
        src.frequency.value = freq * Math.pow(2, osc.octave);
        src.detune.value = osc.detune_cents + spread;
        const g = ctx.createGain();
        g.gain.value = osc.level / (p.oscillators.length * unison);
        src.connect(g).connect(filter);
        src.start(when);
        src.stop(until + p.amp_env.r + 0.05);
        sources.push(src);
      }
    }

    const level = vv * p.gain;
    const env = p.amp_env;
    amp.gain.setValueAtTime(0.0001, when);
    amp.gain.linearRampToValueAtTime(level, when + Math.max(0.001, env.a));
    amp.gain.linearRampToValueAtTime(level * env.s, when + env.a + Math.max(0.001, env.d));

    return {
      nodes: [...sources, filter, amp],
      stop: (t: number) => {
        const at = Math.max(t, when + 0.005);
        try {
          amp.gain.cancelScheduledValues(at);
          amp.gain.setValueAtTime(Math.max(0.0001, amp.gain.value), at);
          amp.gain.exponentialRampToValueAtTime(0.0001, at + Math.max(0.01, env.r));
        } catch {
          /* context may be closing */
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
    const p = note.pitch;

    const noise = (dur: number, hp: number, gain: number, type: BiquadFilterType = "highpass", q = 1) => {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(ctx);
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = hp;
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(gain * vv, when);
      g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
      src.connect(f).connect(g).connect(out);
      src.start(when);
      src.stop(when + dur + 0.02);
      nodes.push(src, f, g);
    };
    const body = (f0: number, f1: number, dur: number, gain: number, type: OscillatorType = "sine") => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(f0, when);
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), when + dur * 0.9);
      const g = ctx.createGain();
      g.gain.setValueAtTime(gain * vv, when);
      g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
      osc.connect(g).connect(out);
      osc.start(when);
      osc.stop(when + dur + 0.02);
      nodes.push(osc, g);
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

    return {
      nodes,
      stop: () => {
        /* percussion voices free-run to their own decay */
      },
    };
  }
}
