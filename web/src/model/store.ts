/** Application state: the loaded project, the mixer, and transport/viewport UI state. */

import { signal } from "@preact/signals";
import type { AssetSource } from "../api/assets";
import type { BackendConfig } from "../api/backend";
import { defaultMixerState, type MixerState } from "../engine/graph";
import type { Note, Project } from "../model/types";
import { notesFromRows } from "../model/types";

export const project = signal<Project | null>(null);
export const assetSource = signal<AssetSource | null>(null);
export const notesByTrack = signal<Record<string, Note[]>>({});
export const mixer = signal<MixerState | null>(null);

export const status = signal<{ text: string; error?: boolean }>({ text: "" });
export const busy = signal(false);
export const playhead = signal(0);
export const playing = signal(false);
export const loopRegion = signal<{ a: number; b: number; on: boolean }>({ a: 0, b: 0, on: false });
export const pxPerSecond = signal(48);
export const scrollX = signal(0);
export const expandedDrums = signal(false);

const STORAGE_KEY = "stemflipper.backend";

export const backend = signal<BackendConfig>(loadBackend());

function loadBackend(): BackendConfig {
  const fromQuery = new URLSearchParams(location.search).get("backend");
  let stored: Partial<BackendConfig> = {};
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    /* first run, or storage blocked */
  }
  const space = new URLSearchParams(location.search).get("space") || "nakas/stemflipper";
  return {
    baseUrl: fromQuery || stored.baseUrl || `https://${space.replace("/", "-")}.hf.space`,
    token: stored.token || null,
  };
}

export function saveBackend(cfg: BackendConfig): void {
  backend.value = cfg;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    /* private window: keep it in memory only */
  }
}

export function loadProject(p: Project, source: AssetSource): void {
  project.value = p;
  assetSource.value = source;
  const notes: Record<string, Note[]> = {};
  for (const t of p.tracks) notes[t.id] = notesFromRows(t.id, t.notes);
  notesByTrack.value = notes;
  mixer.value = defaultMixerState(p);
  playhead.value = 0;
  loopRegion.value = { a: 0, b: 0, on: false };
}

export function updateMixer(fn: (m: MixerState) => void): void {
  const m = mixer.value;
  if (!m) return;
  const next: MixerState = {
    ...m,
    volume: { ...m.volume },
    pan: { ...m.pan },
    mute: { ...m.mute },
    solo: { ...m.solo },
    fx: { ...m.fx },
    lanes: Object.fromEntries(Object.entries(m.lanes).map(([k, v]) => [k, { ...v }])),
  };
  fn(next);
  mixer.value = next;
}

export function duration(): number {
  return project.value?.song.duration ?? 0;
}
