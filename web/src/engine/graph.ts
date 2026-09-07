/** The mixer graph: three lanes per track into one master bus.
 *
 * The graph is built once and PERSISTS across play, stop, seek, mute and solo — only gain
 * values change. v1 tore the whole graph down and rescheduled every note on any mixer
 * move, which clicked and made live faders impossible.
 *
 *   original ─┐
 *   synth    ─┼─ trackIn ─ EQ… ─ pan ─ volume ─ mute ─┬─ master ─ limiter ─ analyser ─ out
 *   sampler  ─┘                                        └─ reverb send ─ convolver ─┘
 */

import type { Project, Track } from "../model/types";
import { buildEqChain, chain, syntheticIR } from "./fx";

export interface TrackNodes {
  id: string;
  lanes: Record<"original" | "synth" | "sampler", GainNode>;
  input: GainNode;
  eq: BiquadFilterNode[];
  pan: StereoPannerNode;
  volume: GainNode;
  mute: GainNode;
  send: GainNode;
  analyser: AnalyserNode;
}

export interface MixGraph {
  master: GainNode;
  limiter: DynamicsCompressorNode;
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

  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1.5;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.1;

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;

  master.connect(limiter).connect(analyser);
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
  return { master, limiter, analyser, convolver, tracks };
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
    lanes[key].gain.value = laneState[key];
    lanes[key].connect(input);
  }

  const eq = state.fx[track.id] ? buildEqChain(ctx, track.effects?.eq?.bands) : [];
  chain(eq, input, pan);
  pan.pan.value = state.pan[track.id] ?? 0;
  pan.connect(volume);
  volume.gain.value = state.volume[track.id] ?? 1;
  volume.connect(mute);
  mute.gain.value = state.mute[track.id] ? 0 : 1;
  mute.connect(analyser);
  analyser.connect(master);

  const send = ctx.createGain();
  send.gain.value = state.fx[track.id] ? (track.effects?.reverb?.mix ?? 0) : 0;
  if (convolver) {
    mute.connect(send);
    send.connect(convolver);
  }

  return { id: track.id, lanes, input, eq, pan, volume, mute, send, analyser };
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
        nodes.lanes[key].gain.setTargetAtTime(laneState[key], when, 0.01);
      }
    }
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
  for (const n of [graph.master, graph.limiter, graph.analyser, graph.convolver]) {
    try {
      n?.disconnect();
    } catch {
      /* fine */
    }
  }
}
