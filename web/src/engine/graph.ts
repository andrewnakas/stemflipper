/** The mixer graph: three lanes per track into one master bus.
 *
 * The graph is built once and PERSISTS across play, stop, seek, mute and solo — only gain
 * values change. v1 tore the whole graph down and rescheduled every note on any mixer
 * move, which clicked and made live faders impossible.
 *
 *   original ─┐
 *   synth    ─┼─ trackIn ─ EQ… ─ pan ─ volume ─ mute ─┬─ master ─ limiter ─ ceiling ─ analyser ─ out
 *   sampler  ─┘                                        └─ reverb send ─ convolver ─┘
 */

import type { Project, Track } from "../model/types";
import { buildEqChain, chain, softCeiling, syntheticIR } from "./fx";

export interface TrackNodes {
  id: string;
  lanes: Record<"original" | "synth" | "sampler", GainNode>;
  input: GainNode;
  eq: BiquadFilterNode[];
  /** Each EQ band's gain when FX are on; the bands sit at 0 dB when they are off. */
  eqTargets: number[];
  pan: StereoPannerNode;
  volume: GainNode;
  mute: GainNode;
  send: GainNode;
  /** The reverb send level when FX are on. */
  sendTarget: number;
  analyser: AnalyserNode;
}

export interface MixGraph {
  master: GainNode;
  limiter: DynamicsCompressorNode;
  /** Memoryless soft ceiling: the thing that actually guarantees no clipping. See fx.ts. */
  ceiling: WaveShaperNode;
  analyser: AnalyserNode;
  convolver: ConvolverNode | null;
  tracks: Map<string, TrackNodes>;
}

export interface MixerState {
  volume: Record<string, number>;
  pan: Record<string, number>;
  mute: Record<string, boolean>;
  solo: Record<string, boolean>;
  lanes: Record<string, Record<"original" | "synth" | "sampler", number>>;
  fx: Record<string, boolean>;
  masterVolume: number;
}

/**
 * Headroom on the sampler lane, so the reconstruction sits at the same level as the source.
 *
 * Measured on the demo fixture by rendering each lane on its own: original peaked at 0.610 and
 * the sampler at **1.046** — clipping, and about 4.7 dB hotter than the stem it is meant to
 * blend against. A sampler voice plays at `velocity/127` of a sample that was already cut at
 * mix level, so four tracks of one-shots stack past full scale and ride the master limiter,
 * which on drum transients reads as distortion. Trimming here matches the two lanes, which is
 * what makes crossfading between them mean anything. The synth lane needs none (it peaked at
 * 0.631 against the same 0.610).
 */
const SAMPLER_TRIM = 0.58;

export function defaultMixerState(project: Project): MixerState {
  const state: MixerState = {
    volume: {}, pan: {}, mute: {}, solo: {}, lanes: {}, fx: {}, masterVolume: 0.9,
  };
  for (const t of project.tracks) {
    state.volume[t.id] = 1;
    state.pan[t.id] = 0;
    state.mute[t.id] = false;
    state.solo[t.id] = false;
    state.fx[t.id] = false;
    // Start on the ORIGINAL stems: that is the song as it actually sounds. The synth and
    // sampler lanes are the reconstruction to blend in.
    state.lanes[t.id] = { original: 1, synth: 0, sampler: 0 };
  }
  return state;
}

export function buildGraph(ctx: BaseAudioContext, project: Project, state: MixerState): MixGraph {
  const master = ctx.createGain();
  master.gain.value = state.masterVolume;

  // The limiter is the only thing between a blend and full scale, and with a 3 ms attack it
  // was not actually doing that job: a three-lane blend of the CI fixture came out at peak
  // 1.004 — transient overshoot, not steady-state gain, since a -1.5 dB threshold at 20:1
  // could never pass unity otherwise. Drum one-shots are nothing but transient, so the attack
  // has to be short enough to catch them. The soft knee is not decoration: it takes the edge
  // off the gain riding that a zero-knee 20:1 wall makes audible on a dense mix.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 4;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.0008;
  limiter.release.value = 0.12;

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;

  const ceiling = softCeiling(ctx);
  master.connect(limiter).connect(ceiling).connect(analyser);
  analyser.connect(ctx.destination);

  let convolver: ConvolverNode | null = null;
  const anyWet = project.tracks.some((t) => t.effects?.reverb?.wet);
  if (anyWet) {
    convolver = ctx.createConvolver();
    const rt = Math.max(
      0.4,
      ...project.tracks.map((t) => t.effects?.reverb?.rt60_s || 0),
    );
    convolver.buffer = syntheticIR(ctx, rt);
    convolver.connect(master);
  }

  const tracks = new Map<string, TrackNodes>();
  for (const t of project.tracks) {
    tracks.set(t.id, buildTrack(ctx, t, state, master, convolver));
  }
  return { master, limiter, ceiling, analyser, convolver, tracks };
}

function buildTrack(
  ctx: BaseAudioContext,
  track: Track,
  state: MixerState,
  master: GainNode,
  convolver: ConvolverNode | null,
): TrackNodes {
  const input = ctx.createGain();
  const pan = ctx.createStereoPanner();
  const volume = ctx.createGain();
  const mute = ctx.createGain();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;

  const lanes = {
    original: ctx.createGain(),
    synth: ctx.createGain(),
    sampler: ctx.createGain(),
  };
  const laneState = state.lanes[track.id] || { original: 1, synth: 0, sampler: 0 };
  for (const key of ["original", "synth", "sampler"] as const) {
    lanes[key].gain.value = laneState[key] * laneTrim(key);
    lanes[key].connect(input);
  }

  // The EQ is built whether or not FX are on, with its bands flat until they are: the chain
  // cannot be inserted later without rebuilding the graph, and rebuilding the graph mid-song
  // is exactly what this design exists to avoid. `applyMixer` ramps the band gains, so the
  // button is live. A handful of biquads per track is cheap.
  const eq = buildEqChain(ctx, track.effects?.eq?.bands);
  const eqOn = !!state.fx[track.id];
  // Read the targets off the nodes rather than re-deriving them from the bands: buildEqChain
  // drops inaudible bands, and a second copy of that rule would misalign the indices.
  const eqTargets = eq.map((b) => b.gain.value);
  for (const band of eq) if (!eqOn) band.gain.value = 0;
  chain(eq, input, pan);
  pan.pan.value = state.pan[track.id] ?? 0;
  pan.connect(volume);
  volume.gain.value = state.volume[track.id] ?? 1;
  volume.connect(mute);
  mute.gain.value = state.mute[track.id] ? 0 : 1;
  mute.connect(analyser);
  analyser.connect(master);

  const send = ctx.createGain();
  const sendTarget = track.effects?.reverb?.mix ?? 0;
  send.gain.value = eqOn ? sendTarget : 0;
  if (convolver) {
    mute.connect(send);
    send.connect(convolver);
  }

  return {
    id: track.id, lanes, input, eq, eqTargets, pan, volume, mute, send, sendTarget, analyser,
  };
}

/** Fixed per-lane trim, so a fader at 1 means the same loudness on every lane. */
function laneTrim(lane: "original" | "synth" | "sampler"): number {
  return lane === "sampler" ? SAMPLER_TRIM : 1;
}

/** Solo wins over mute; with nothing soloed, mute decides. */
export function audibleGain(state: MixerState, id: string): number {
  const anySolo = Object.values(state.solo).some(Boolean);
  if (anySolo) return state.solo[id] ? 1 : 0;
  return state.mute[id] ? 0 : 1;
}

export function applyMixer(graph: MixGraph, state: MixerState, when: number): void {
  graph.master.gain.setTargetAtTime(state.masterVolume, when, 0.01);
  for (const [id, nodes] of graph.tracks) {
    nodes.volume.gain.setTargetAtTime(state.volume[id] ?? 1, when, 0.01);
    nodes.pan.pan.setTargetAtTime(state.pan[id] ?? 0, when, 0.01);
    nodes.mute.gain.setTargetAtTime(audibleGain(state, id), when, 0.01);
    const laneState = state.lanes[id];
    if (laneState) {
      for (const key of ["original", "synth", "sampler"] as const) {
        nodes.lanes[key].gain.setTargetAtTime(laneState[key] * laneTrim(key), when, 0.01);
      }
    }
    // FX: ramp the EQ bands and the reverb send rather than leaving the button inert until
    // something happens to rebuild the graph.
    const on = !!state.fx[id];
    const targets = nodes.eqTargets;
    nodes.eq.forEach((band, i) => {
      band.gain.setTargetAtTime(on ? (targets[i] ?? 0) : 0, when, 0.02);
    });
    nodes.send.gain.setTargetAtTime(on ? nodes.sendTarget : 0, when, 0.02);
  }
}

export function disposeGraph(graph: MixGraph | null): void {
  if (!graph) return;
  for (const nodes of graph.tracks.values()) {
    for (const n of [
      ...Object.values(nodes.lanes), nodes.input, nodes.pan, nodes.volume,
      nodes.mute, nodes.send, nodes.analyser, ...nodes.eq,
    ]) {
      try {
        n.disconnect();
      } catch {
        /* fine */
      }
    }
  }
  for (const n of [graph.master, graph.limiter, graph.ceiling, graph.analyser, graph.convolver]) {
    try {
      n?.disconnect();
    } catch {
      /* fine */
    }
  }
}
