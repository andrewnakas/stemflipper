import { render } from "preact";
import { fetchJson } from "./api/assets";
import { App, openProject } from "./ui/App";
import {
  assetSource, commitEdit, mixer, notesByTrack, project, redo, status, undo, updateMixer,
} from "./model/store";
import type { Project } from "./model/types";
import "./ui/theme.css";

const root = document.getElementById("app")!;
render(<App />, root);

// Test/automation surface: the smoke test drives the app through this.
(window as any).__sf = {
  ready: false,
  session: null as unknown,
  get state() {
    return {
      project: project.value,
      mixer: mixer.value,
      notes: notesByTrack.value,
      source: assetSource.value,
    };
  },
  async renderMix(opts?: { to?: number }) {
    const { renderMix } = await import("./engine/render");
    const { bufferRms, bufferPeak } = await import("./engine/render");
    const buf = await renderMix(project.value!, assetSource.value!, mixer.value!, notesByTrack.value, {
      to: opts?.to ?? Math.min(4, project.value!.song.duration),
    });
    return { rms: bufferRms(buf), peak: bufferPeak(buf), duration: buf.duration };
  },
  /** Drive the mixer from a test: __sf.setLane("bass", "synth", 1). */
  /** Move the first note of a track, as a drag would: __sf.editFirstNote("bass", 0.25). */
  async editFirstNote(trackId: string, deltaTime = 0.25, deltaPitch = 2) {
    const { moveNotes } = await import("./model/notes");
    const notes = notesByTrack.value[trackId] || [];
    if (!notes.length) return null;
    const before = { ...notes[0] };
    commitEdit(
      trackId,
      "test-move",
      moveNotes(notes, new Set([before.id]), deltaTime, deltaPitch, project.value!.grid, 0),
    );
    // look the note up BY ID: an edit re-sorts the track, so index 0 may be a different note
    const after = (notesByTrack.value[trackId] || []).find((n) => n.id === before.id);
    return { id: before.id, before, after: after ? { ...after } : null };
  },
  undo() {
    return undo();
  },
  redo() {
    return redo();
  },
  async exportZip() {
    const { buildExportZip } = await import("./export/bundle");
    const blob = await buildExportZip(project.value!, assetSource.value!, mixer.value!, notesByTrack.value, {
      midi: true,
      mix: false,
      stems: false,
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { size: bytes.length, bytes: Array.from(bytes.slice(0, 4)) };
  },
  async exportMidiBytes() {
    const { writeMidi } = await import("./export/midi");
    const p = project.value!;
    const tracks = p.tracks.map((t) => ({
      name: t.id,
      isDrum: t.kind === "drums",
      notes: notesByTrack.value[t.id] || [],
    }));
    return Array.from(writeMidi(tracks, p.grid, p.sections));
  },
  setLane(trackId: string, lane: "original" | "synth" | "sampler", value: number) {
    updateMixer((s) => {
      if (s.lanes[trackId]) s.lanes[trackId][lane] = value;
    });
    const session = (window as any).__sf.session;
    if (session && mixer.value) session.applyMixer(mixer.value);
    return mixer.value?.lanes[trackId];
  },
};

async function boot() {
  const params = new URLSearchParams(location.search);
  const fixture = params.get("fixture");
  const bundle = params.get("bundle");
  try {
    if (fixture) {
      const base = `${import.meta.env.BASE_URL}fixtures/${fixture}`.replace(/\/+$/, "");
      const data = await fetchJson<Project>(`${base}/project.json`);
      await openProject(data, { kind: "static", baseUrl: base });
    } else if (bundle) {
      status.value = { text: "Loading the bundle from the backend…" };
      const { backend } = await import("./model/store");
      const { assetUrl } = await import("./api/assets");
      const source = { kind: "server" as const, backend: backend.value, bundleRoot: bundle };
      const data = await fetchJson<Project>(assetUrl(source, "project.json"));
      await openProject(data, source);
    }
  } catch (e) {
    status.value = { text: `Could not load: ${(e as Error).message}`, error: true };
  } finally {
    (window as any).__sf.ready = true;
  }
}

void boot();
