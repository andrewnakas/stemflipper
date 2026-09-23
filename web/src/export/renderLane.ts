/**
 * Render one lane of one track on its own.
 *
 * The synth and sampler reconstructions only exist as a graph in this tab — there is no
 * file behind them — so sending them anywhere means rendering them first. This reuses the
 * same offline path as the mix export, with a mixer state that silences everything except
 * the one lane being asked for, so what comes out is exactly what that fader plays.
 */

import { renderMix } from "../engine/render";
import { defaultMixerState, type MixerState } from "../engine/graph";
import type { AssetSource } from "../api/assets";
import type { LaneId, Note, Project, Track } from "../model/types";

export interface LaneRef {
  track: Track;
  lane: LaneId;
}

/** Everything silenced but one lane of one track, at unity. */
export function isolate(project: Project, trackId: string, lane: LaneId): MixerState {
  const state = defaultMixerState(project);
  for (const t of project.tracks) {
    state.lanes[t.id] = { original: 0, synth: 0, sampler: 0 };
    state.volume[t.id] = 1;
    state.pan[t.id] = 0;
    state.mute[t.id] = false;
    state.solo[t.id] = false;
    // The measured EQ and reverb belong to the mix, not to a stem someone is about to
    // edit; they can always be added again in the editor.
    state.fx[t.id] = false;
  }
  state.lanes[trackId][lane] = 1;
  state.masterVolume = 1;
  return state;
}

export function renderLane(
  project: Project,
  source: AssetSource,
  notesByTrack: Record<string, Note[]>,
  trackId: string,
  lane: LaneId,
): Promise<AudioBuffer> {
  return renderMix(project, source, isolate(project, trackId, lane), notesByTrack, {
    sampleRate: project.song.sample_rate || 44100,
  });
}

/** Which lanes of a track can actually produce sound. */
export function availableLanes(track: Track, notes: Note[]): LaneId[] {
  const out: LaneId[] = [];
  if (track.audio?.src && !track.audio.silent) out.push("original");
  if (notes.length) {
    // The synth has a built-in voice when a track has no fitted patch, so notes are enough.
    out.push("synth");
    // The sampler has nothing to play without a sample map.
    if (track.instrument?.sampler) out.push("sampler");
  }
  return out;
}

export const LANE_LABELS: Record<LaneId, string> = {
  original: "Original",
  synth: "Synth",
  sampler: "Sampler",
};

/** Bytes a rendered lane will take as 16-bit stereo WAV — shown before committing to it. */
export function renderedBytes(durationS: number, sampleRate = 44100): number {
  return Math.round(durationS * sampleRate * 2 * 2) + 44;
}
