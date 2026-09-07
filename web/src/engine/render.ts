/** Offline render: the same graph, the same scheduling, straight to an AudioBuffer. */

import type { Note, Project } from "../model/types";
import type { AssetSource } from "../api/assets";
import type { MixerState } from "./graph";
import { Session } from "./session";

const TAIL_S = 1.5;

export async function renderMix(
  project: Project,
  source: AssetSource,
  state: MixerState,
  notesByTrack: Record<string, Note[]>,
  opts: { from?: number; to?: number; sampleRate?: number } = {},
): Promise<AudioBuffer> {
  const from = opts.from ?? 0;
  const to = opts.to ?? project.song.duration;
  const sampleRate = opts.sampleRate ?? 44100;
  const length = Math.max(1, Math.ceil((to - from + TAIL_S) * sampleRate));

  const Ctor: typeof OfflineAudioContext =
    (window as any).OfflineAudioContext || (window as any).webkitOfflineAudioContext;
  const ctx = new Ctor(2, length, sampleRate);

  const session = new Session(project, source, state, ctx);
  await session.load(notesByTrack);
  session.applyMixer(state);

  // Offline has no real clock, so schedule everything up front rather than in a window.
  for (const track of project.tracks) {
    const notes = (notesByTrack[track.id] || []).filter((n) => n.end > from && n.start < to);
    const runtime = (session as any).runtimes.get(track.id);
    if (!runtime) continue;
    runtime.audio.startAt(0, from);
    for (const n of notes) {
      const when = Math.max(0, n.start - from);
      const until = Math.max(when + 0.02, n.end - from);
      runtime.synth.noteOn(n, when, until);
      runtime.sampler.noteOn(n, when, until);
      runtime.synth.noteOff(n.id, until);
      runtime.sampler.noteOff(n.id, until);
    }
  }

  const rendered = await ctx.startRendering();
  session.dispose();
  return rendered;
}

export function bufferPeak(buffer: AudioBuffer): number {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i += 16) peak = Math.max(peak, Math.abs(data[i]));
  }
  return peak;
}

export function bufferRms(buffer: AudioBuffer): number {
  let sum = 0;
  let n = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i += 16) {
      sum += data[i] * data[i];
      n++;
    }
  }
  return n ? Math.sqrt(sum / n) : 0;
}
