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
