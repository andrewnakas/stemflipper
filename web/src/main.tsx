import { render } from "preact";
import { restoreAuth } from "./model/auth";
import { job, jobLog, openBundle, openFixture } from "./model/jobStore";
import { session } from "./model/playback";
import {
  assetSource, commitEdit, mixer, notesByTrack, project, redo, status, undo, updateMixer,
} from "./model/store";
import { App } from "./ui/App";
import { navigate, param, route } from "./ui/router";
import { toast } from "./ui/components/Toast";
import "./ui/theme.css";

const root = document.getElementById("app")!;
render(<App />, root);

// Test/automation surface: the smoke test drives the app through this.
(window as any).__sf = {
  ready: false,
  session: null as unknown,
  get route() {
    return route.value;
  },
  get job() {
    return job.value;
  },
  get jobLog() {
    return jobLog.value;
  },
  navigate,
  get state() {
    return {
      project: project.value,
      mixer: mixer.value,
      notes: notesByTrack.value,
      source: assetSource.value,
    };
  },
  /** Stems play before patches and sampler zones finish; wait for the rest. */
  async waitForInstruments() {
    await session.value?.instrumentsReady;
    return true;
  },
  /**
   * Render a blend to a WAV, base64, so a test can pull the audio out and listen to it.
   * `lanes` sets every track's three faders, e.g. {original: 0, synth: 1, sampler: 1}.
   */
  async renderWav(opts?: { to?: number; lanes?: { original: number; synth: number; sampler: number } }) {
    const to = opts?.to ?? Math.min(20, project.value!.song.duration);
    const want = opts?.lanes;
    if (want) {
      for (const t of project.value!.tracks) {
        for (const l of ["original", "synth", "sampler"] as const) {
          (window as any).__sf.setLane(t.id, l, want[l]);
        }
      }
    }
    const { renderMix } = await import("./engine/render");
    const { encodeWav } = await import("./export/wav");
    const buf = await renderMix(project.value!, assetSource.value!, mixer.value!, notesByTrack.value, { to });
    const blob = encodeWav(buf, 16);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  },
  async renderMix(opts?: { to?: number }) {
    const { renderMix, bufferRms, bufferPeak } = await import("./engine/render");
    const buf = await renderMix(project.value!, assetSource.value!, mixer.value!, notesByTrack.value, {
      to: opts?.to ?? Math.min(4, project.value!.song.duration),
    });
    return { rms: bufferRms(buf), peak: bufferPeak(buf), duration: buf.duration };
  },
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
    if (mixer.value) session.value?.applyMixer(mixer.value);
    return mixer.value?.lanes[trackId];
  },
};

async function boot() {
  try {
    await restoreAuth();
  } catch {
    /* anonymous still works */
  }

  const fixture = param("fixture");
  const bundle = param("bundle");
  try {
    if (fixture) {
      await openFixture(fixture);
    } else if (bundle) {
      await openBundle(bundle);
    } else if (location.hash && location.hash !== "#/" && !project.value) {
      // A deep link to a screen with nothing loaded: start at the front door.
      navigate("home", { replace: true });
    }
  } catch (e) {
    status.value = { text: `Could not load: ${(e as Error).message}`, error: true };
    toast(`Could not load that project: ${(e as Error).message}`, { tone: "error" });
    navigate("home", { replace: true });
  } finally {
    (window as any).__sf.ready = true;
  }
}

void boot();
