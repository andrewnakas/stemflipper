/** Binds a loaded project to a live audio graph: lanes, buffers, transport.
 *
 * Everything the page can hear lives behind this one object, so the UI never touches
 * WebAudio directly and an offline render can rebuild the identical graph.
 */

import { assetUrl, decodeAudio, fetchJson, type AssetSource } from "../api/assets";
import type { Instrument, Note, Patch, Project } from "../model/types";
import { audioContext } from "./context";
import { applyMixer, buildGraph, disposeGraph, type MixerState, type MixGraph } from "./graph";
import { AudioLane } from "./lanes/audioLane";
import { SamplerLane } from "./lanes/samplerLane";
import { SynthLane } from "./lanes/synthLane";
import { Transport, type TrackRuntime } from "./transport";

export class Session {
  readonly ctx: BaseAudioContext;
  graph: MixGraph;
  transport: Transport;
  /** Resolves when patches and sampler zones have finished loading. */
  instrumentsReady: Promise<void> = Promise.resolve();
  private runtimes = new Map<string, TrackRuntime>();

  constructor(
    private projectData: Project,
    private source: AssetSource,
    state: MixerState,
    ctx?: BaseAudioContext,
  ) {
    this.ctx = ctx || audioContext();
    this.graph = buildGraph(this.ctx, projectData, state);
    this.transport = new Transport(this.ctx);
    this.transport.duration = projectData.song.duration;
  }

  /**
   * Build a runtime per track.
   *
   * Resolves as soon as the STEMS can play. Patches and sampler zones keep loading in the
   * background and attach when they arrive: a real song's sampler zones are dozens of
   * small files, and waiting for all of them put five seconds between "Hear an example"
   * and hearing anything. Both those lanes start at gain 0 anyway (defaultMixerState), so
   * nothing is audibly missing in the meantime — and `instrumentsReady` is there for
   * anyone who needs to wait for the rest.
   */
  async load(notesByTrack: Record<string, Note[]>): Promise<void> {
    const runtimes: TrackRuntime[] = [];
    for (const track of this.projectData.tracks) {
      const nodes = this.graph.tracks.get(track.id);
      if (!nodes) continue;
      const runtime: TrackRuntime = {
        id: track.id,
        notes: notesByTrack[track.id] || [],
        audio: new AudioLane(this.ctx, nodes.lanes.original, null),
        synth: new SynthLane(this.ctx, nodes.lanes.synth, null, track.kind === "drums"),
        sampler: new SamplerLane(this.ctx, nodes.lanes.sampler, null, (rel) =>
          assetUrl(this.source, rel),
        ),
        cursor: 0,
        sounding: new Map(),
      };
      this.runtimes.set(track.id, runtime);
      runtimes.push(runtime);
    }
    this.transport.setTracks(runtimes);

    const audio: Promise<unknown>[] = [];
    const instruments: Promise<unknown>[] = [];

    for (const track of this.projectData.tracks) {
      const runtime = this.runtimes.get(track.id);
      if (!runtime) continue;

      if (track.audio.src && !track.audio.silent) {
        audio.push(
          decodeAudio(this.ctx, assetUrl(this.source, track.audio.src), { mono: true })
            .then((buf) => runtime.audio.setBuffer(buf))
            .catch(() => undefined),
        );
      }
      if (track.instrument.patch) {
        instruments.push(
          fetchJson<Patch>(assetUrl(this.source, track.instrument.patch))
            .then((patch) => runtime.synth.setPatch(patch))
            .catch(() => undefined),
        );
      }
      if (track.instrument.sampler) {
        instruments.push(
          fetchJson<Instrument>(assetUrl(this.source, track.instrument.sampler))
            .then(async (inst) => {
              const lane = new SamplerLane(
                this.ctx,
                this.graph.tracks.get(track.id)!.lanes.sampler,
                inst,
                (rel) => assetUrl(this.source, rel),
              );
              await lane.load();
              runtime.sampler = lane;
            })
            .catch(() => undefined),
        );
      }
    }

    await Promise.all(audio);
    this.transport.setTracks([...this.runtimes.values()]);

    this.instrumentsReady = Promise.all(instruments).then(() => {
      // The runtimes are mutated in place, but re-seat them so the transport re-bisects
      // its cursors against the lanes that just appeared.
      this.transport.setTracks([...this.runtimes.values()]);
    });
  }

  setNotes(trackId: string, notes: Note[]): void {
    const runtime = this.runtimes.get(trackId);
    if (!runtime) return;
    runtime.notes = notes;
    this.transport.notesChanged();
  }

  applyMixer(state: MixerState): void {
    applyMixer(this.graph, state, this.ctx.currentTime);
  }

  /** Per-track output level, for the meters. */
  levels(): Record<string, number> {
    const out: Record<string, number> = {};
    const buf = new Float32Array(256);
    for (const [id, nodes] of this.graph.tracks) {
      try {
        nodes.analyser.getFloatTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
        out[id] = peak;
      } catch {
        out[id] = 0;
      }
    }
    return out;
  }

  dispose(): void {
    this.transport.dispose();
    disposeGraph(this.graph);
    this.runtimes.clear();
  }
}
