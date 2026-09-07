import { render } from "preact";
import { fetchJson } from "./api/assets";
import { App, openProject } from "./ui/App";
import { assetSource, mixer, notesByTrack, project, status, updateMixer } from "./model/store";
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
