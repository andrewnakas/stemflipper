/**
 * Keeping a song in the browser.
 *
 * A finished run lives on the Space for six hours and then the bundle is pruned, so a
 * visitor who comes back tomorrow has a project.json pointing at files that no longer
 * exist. This stores what the page needs to play and edit the song — the stems, the
 * instruments, and any note edits — in IndexedDB, so it keeps working offline and after
 * the server has forgotten it.
 *
 * Deliberately NOT the whole bundle: a 30-second song's zip is 57 MB, most of it loops
 * and 24-bit samples that only matter if you download them. What is stored here is what
 * the page itself loads.
 */

import { assetUrl, fetchBytes, type AssetSource } from "../api/assets";
import type { Attribution } from "./jobStore";
import { rowsFromNotes } from "./types";
import type { Instrument, Note, Project } from "./types";

const DB_NAME = "stemflipper";
const DB_VERSION = 1;
const STORE = "projects";

export interface SavedSong {
  id: string;
  name: string;
  savedAt: number;
  /**
   * The project with any note edits already written into tracks[].notes. Baking them in
   * rather than storing a separate diff means reopening a saved song is the same code
   * path as opening any other project — there is no "restore edits" step to get wrong.
   */
  project: Project;
  mixer: unknown;
  attribution: Attribution | null;
  assets: Record<string, Blob>;
  bytes: number;
}

/** What a listing needs, without pulling every blob into memory. */
export interface SongSummary {
  id: string;
  name: string;
  savedAt: number;
  bytes: number;
  tracks: number;
  duration: number;
  attribution: Attribution | null;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("This browser cannot store songs offline."));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("Could not open local storage."));
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      }),
  );
}

/**
 * Every asset the page fetches to play a song: the stems, each track's synth patch and
 * sampler map, and every sample the sampler map names.
 */
export async function playableAssets(project: Project, source: AssetSource): Promise<string[]> {
  const paths = new Set<string>();
  const instruments: string[] = [];

  for (const t of project.tracks) {
    if (t.audio.src && !t.audio.silent) paths.add(t.audio.src);
    if (t.instrument?.patch) paths.add(t.instrument.patch);
    if (t.instrument?.sampler) {
      paths.add(t.instrument.sampler);
      instruments.push(t.instrument.sampler);
    }
    if (t.midi) paths.add(t.midi);
  }
  if (project.midi?.song) paths.add(project.midi.song);

  // Sample zones are listed inside the instrument files, not in project.json.
  for (const rel of instruments) {
    try {
      const bytes = await fetchBytes(assetUrl(source, rel));
      const inst = JSON.parse(new TextDecoder().decode(bytes)) as Instrument;
      const zones =
        "zones" in inst ? inst.zones : Object.values(inst.pieces || {}).flatMap((p) => p.zones || []);
      for (const z of zones) if (z.path) paths.add(z.path.replace(/^\/+/, ""));
    } catch {
      // A missing instrument file just means fewer samples cached, not a failed save.
    }
  }
  return [...paths];
}

export async function saveSong(
  project: Project,
  source: AssetSource,
  notesByTrack: Record<string, Note[]>,
  mixer: unknown,
  attribution: Attribution | null,
  onProgress?: (done: number, total: number) => void,
): Promise<SavedSong> {
  const paths = await playableAssets(project, source);
  const assets: Record<string, Blob> = {};
  let bytes = 0;

  for (let i = 0; i < paths.length; i++) {
    onProgress?.(i, paths.length);
    try {
      const buf = await fetchBytes(assetUrl(source, paths[i]));
      assets[paths[i]] = new Blob([buf]);
      bytes += buf.byteLength;
    } catch {
      // Skip what has already expired rather than failing the whole save.
    }
  }
  onProgress?.(paths.length, paths.length);

  const edited: Project = {
    ...project,
    _server: undefined,
    tracks: project.tracks.map((t) =>
      notesByTrack[t.id] ? { ...t, notes: rowsFromNotes(notesByTrack[t.id]) } : t,
    ),
  };

  const song: SavedSong = {
    id: songId(project),
    name: attribution?.title || titleOf(project),
    savedAt: Date.now(),
    project: edited,
    mixer,
    attribution,
    assets,
    bytes,
  };
  await tx("readwrite", (s) => s.put(song));
  return song;
}

export async function listSongs(): Promise<SongSummary[]> {
  try {
    const all = await tx<SavedSong[]>("readonly", (s) => s.getAll() as IDBRequest<SavedSong[]>);
    return all
      .map((s) => ({
        id: s.id,
        name: s.name,
        savedAt: s.savedAt,
        bytes: s.bytes,
        tracks: s.project?.tracks?.length ?? 0,
        duration: s.project?.song?.duration ?? 0,
        attribution: s.attribution ?? null,
      }))
      .sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return []; // private window, or storage blocked: just show nothing
  }
}

export function getSong(id: string): Promise<SavedSong | undefined> {
  return tx<SavedSong | undefined>("readonly", (s) => s.get(id) as IDBRequest<SavedSong | undefined>);
}

export function deleteSong(id: string): Promise<void> {
  return tx("readwrite", (s) => s.delete(id)).then(() => undefined);
}

/** Turn stored blobs into an asset source the engine can read. */
export function sourceFor(song: SavedSong): AssetSource {
  const urls: Record<string, string> = {};
  for (const [rel, blob] of Object.entries(song.assets)) urls[rel] = URL.createObjectURL(blob);
  return { kind: "blob", urls };
}

/** Object URLs live until revoked; call when replacing a blob source. */
export function releaseSource(source: AssetSource): void {
  if (source.kind !== "blob") return;
  for (const url of Object.values(source.urls || {})) URL.revokeObjectURL(url);
}

export function songId(project: Project): string {
  const song = project.song || ({} as Project["song"]);
  return `${song.source_file || "song"}:${Math.round((song.duration || 0) * 100)}:${project.app?.created_utc || ""}`;
}

function titleOf(project: Project): string {
  return (project.song?.source_file || "Untitled").replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
}

export async function storageUsed(): Promise<{ usage: number; quota: number } | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    return e ? { usage: e.usage || 0, quota: e.quota || 0 } : null;
  } catch {
    return null;
  }
}
