/** Application state: the loaded project, the mixer, and transport/viewport UI state. */

import { signal } from "@preact/signals";
import type { AssetSource } from "../api/assets";
import type { BackendConfig } from "../api/backend";
import { defaultMixerState, type MixerState } from "../engine/graph";
import { History, applyEdit, editFrom, type NoteEdit } from "./commands";
import type { Change } from "./notes";
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
export const selection = signal<Set<string>>(new Set());
export const selectedTrack = signal<string | null>(null);
export const tool = signal<"select" | "draw" | "erase">("select");
export const snapDivision = signal(4); // 4 = 16ths, 0 = off
export const historyDepth = signal(0);
export const edited = signal(false);

const history = new History();

/** Apply a set of note changes as one undoable edit. */
export function commitEdit(
  trackId: string,
  label: string,
  changes: Change[],
  coalesceKey?: string,
): void {
  if (!changes.length) return;
  const edit = editFrom(trackId, label, changes, coalesceKey);
  history.push(edit);
  applyToStore(edit, "do");
  historyDepth.value = history.depth;
  edited.value = true;
}

/** Live preview during a drag: change the notes without touching history. */
export function previewEdit(trackId: string, changes: Change[]): void {
  if (!changes.length) return;
  applyToStore(editFrom(trackId, "preview", changes), "do");
}

function applyToStore(edit: NoteEdit, direction: "do" | "undo"): void {
  const current = notesByTrack.value[edit.trackId] || [];
  const next = applyEdit(current, edit, direction);
  notesByTrack.value = { ...notesByTrack.value, [edit.trackId]: next };
  onNotesChanged?.(edit.trackId, next);
}

export let onNotesChanged: ((trackId: string, notes: Note[]) => void) | null = null;
export function setNotesListener(fn: typeof onNotesChanged): void {
  onNotesChanged = fn;
}

export function undo(): boolean {
  const edit = history.undo();
  if (!edit) return false;
  applyToStore(edit, "undo");
  historyDepth.value = history.depth;
  return true;
}

export function redo(): boolean {
  const edit = history.redo();
  if (!edit) return false;
  applyToStore(edit, "do");
  historyDepth.value = history.depth;
  return true;
}

export function canUndo(): boolean {
  return history.canUndo;
}

export function canRedo(): boolean {
  return history.canRedo;
}

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
  history.clear();
  historyDepth.value = 0;
  edited.value = false;
  selection.value = new Set();
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
