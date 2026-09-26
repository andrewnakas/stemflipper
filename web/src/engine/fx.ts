/** Per-track inserts: EQ from the measured curve, and a reverb send from the fitted IR. */

import type { EqBand } from "../model/types";

export function buildEqChain(ctx: BaseAudioContext, bands: EqBand[] | undefined): BiquadFilterNode[] {
  if (!bands || !bands.length) return [];
  return bands
    .filter((b) => Math.abs(b.gain_db) > 0.25) // skip inaudible bands: each one costs a node
    .map((b) => {
      const node = ctx.createBiquadFilter();
      node.type = "peaking";
      node.frequency.value = Math.max(20, Math.min(ctx.sampleRate / 2 - 100, b.freq));
      node.Q.value = b.q || 1.0;
      node.gain.value = Math.max(-24, Math.min(24, b.gain_db));
      return node;
    });
}

export function chain(nodes: AudioNode[], input: AudioNode, output: AudioNode): void {
  let prev = input;
  for (const n of nodes) {
    prev.connect(n);
    prev = n;
  }
  prev.connect(output);
}

/**
 * A guaranteed ceiling.
 *
 * `DynamicsCompressorNode` is a compressor, not a peak limiter: it overshoots on transients, and
 * relying on it to keep a mix inside full scale does not work — a three-lane blend came out at
 * peak 1.004 with a -1.5 dB threshold at 20:1, which no steady-state gain could explain. A
 * WaveShaperNode is memoryless, so whatever curve it is given IS its output range, and a soft
 * one cannot clip however hard it is driven.
 *
 * Below `linearTo` the curve is exactly y = x, so ordinary listening is untouched; above it the
 * curve bends with a tanh whose derivative is 1 at the join (no corner) and which asymptotes to
 * `ceiling`. At unity in it gives about 0.92 out; it would need an input of 2.0 to reach 0.98.
 */
export function softCeiling(ctx: BaseAudioContext, linearTo = 0.7, ceiling = 0.98): WaveShaperNode {
  const n = 8192;
  const curve = new Float32Array(n);
  const span = ceiling - linearTo;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1; // -1..1
    const a = Math.abs(x);
    const y = a <= linearTo ? a : linearTo + span * Math.tanh((a - linearTo) / span);
    curve[i] = Math.sign(x) * y;
  }
  const shaper = ctx.createWaveShaper();
  shaper.curve = curve;
  // The bend generates harmonics; oversampling keeps them from folding back as aliases.
  shaper.oversample = "2x";
  return shaper;
}

const irCache = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>();

/** A decaying-noise impulse response, used when the bundle has no IR file. */
export function syntheticIR(ctx: BaseAudioContext, rt60 = 1.6): AudioBuffer {
  let perCtx = irCache.get(ctx);
  if (!perCtx) {
    perCtx = new Map();
    irCache.set(ctx, perCtx);
  }
  const key = rt60.toFixed(2);
  const hit = perCtx.get(key);
  if (hit) return hit;

  const sr = ctx.sampleRate;
  const len = Math.max(1, Math.floor(Math.min(3.0, rt60) * sr));
  const buf = ctx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const data = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.5) * Math.min(1, t * 40);
    }
  }
  perCtx.set(key, buf);
  return buf;
}
