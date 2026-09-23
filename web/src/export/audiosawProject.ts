/**
 * Export selected tracks as an AudioSaw editor project (.audiosaw).
 *
 * audiosaw.com has a multitrack, non-destructive editor, and StemFlipper is served from
 * the same origin — so separated stems can go straight onto its timeline instead of being
 * downloaded and dragged back in one at a time.
 *
 * The format is the editor's own: a zip holding project.json and one audio file per
 * source. Two details are load-bearing and come from reading its reader, not from
 * guessing:
 *  - entries must be STORED, not deflated. Its unzip is a small inline one that throws
 *    "This project file is compressed" on anything else.
 *  - project.json is normalised on import, so master, buses, fx, sends and automation can
 *    be left out and the editor fills in its own defaults.
 */

import { zip, type AsyncZippable } from "fflate";
import { assetUrl, fetchBytes, type AssetSource } from "../api/assets";
import type { Project, Track } from "../model/types";

/** The handoff store flow.js and the service worker share. Version 1, and it must stay 1. */
const HANDOFF_DB = "audiosaw";
const HANDOFF_STORE = "handoff";
const EDITOR_PATH = "/audio-editor";

export interface AudiosawExportProgress {
  done: number;
  total: number;
  name: string;
}

function extOf(path: string): string {
  return (path.split(".").pop() || "wav").toLowerCase();
}

/** A source id the editor will accept: its own ids look like "s3". */
function sourceId(i: number): string {
  return `sfs${i + 1}`;
}

export async function buildAudiosawProject(
  project: Project,
  source: AssetSource,
  tracks: Track[],
  opts: { title?: string; onProgress?: (p: AudiosawExportProgress) => void } = {},
): Promise<Blob> {
  const files: AsyncZippable = {};
  const sources: Record<string, unknown> = {};
  const outTracks: unknown[] = [];

  let i = 0;
  for (const track of tracks) {
    const rel = track.audio?.src;
    if (!rel || track.audio.silent) continue;
    opts.onProgress?.({ done: i, total: tracks.length, name: track.name });

    const bytes = await fetchBytes(assetUrl(source, rel));
    const id = sourceId(i);
    const ext = extOf(rel);
    const path = `sources/${id}.${ext}`;
    // level 0: the editor's reader refuses anything but stored entries.
    files[path] = [new Uint8Array(bytes), { level: 0 }];

    sources[id] = {
      id,
      name: `${track.name}.${ext}`,
      duration: project.song.duration,
      channels: project.song.channels || 2,
      sampleRate: project.song.sample_rate || 44100,
      kind: "file",
      path,
    };

    outTracks.push({
      id: `sft${i + 1}`,
      name: track.name,
      volDb: 0,
      pan: 0,
      mute: false,
      solo: false,
      clips: [
        {
          id: `sfc${i + 1}`,
          sourceId: id,
          name: track.name,
          // Stems are the same length as the song and start together; that is the whole
          // point of a separation, and it is what makes them line up on the timeline.
          start: 0,
          offset: 0,
          duration: project.song.duration,
          gainDb: 0,
          fadeIn: 0,
          fadeOut: 0,
        },
      ],
      fx: [],
      sends: {},
      auto: {},
    });
    i++;
  }

  if (!outTracks.length) throw new Error("None of the chosen tracks has any audio.");

  const projectJson = {
    v: 1,
    name: opts.title || project.song.source_file.replace(/\.[^.]+$/, "") || "StemFlipper project",
    tracks: outTracks,
    sources,
    markers: [],
  };
  files["project.json"] = [
    new TextEncoder().encode(JSON.stringify(projectJson, null, 1)),
    { level: 0 },
  ];
  opts.onProgress?.({ done: tracks.length, total: tracks.length, name: "project" });

  return new Promise((resolve, reject) => {
    zip(files, { level: 0 }, (err, data) => {
      if (err) reject(new Error(`Could not build the project: ${err.message}`));
      else resolve(new Blob([new Uint8Array(data)], { type: "application/zip" }));
    });
  });
}

/** Is the editor reachable from here? Only same-origin, since the handoff is IndexedDB. */
export function editorAvailable(): boolean {
  return typeof indexedDB !== "undefined" && /(^|\.)audiosaw\.com$/.test(location.hostname);
}

/**
 * Put a file where audiosaw's tools look for one.
 *
 * Same contract flow.js uses between its own tools: one record under "pending", then
 * navigate with ?from=. The version MUST stay 1 — flow.js and the service worker both
 * open this database, and a third writer bumping it makes one of them throw VersionError.
 */
export function handoffToAudiosaw(name: string, blob: Blob): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HANDOFF_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(HANDOFF_STORE)) req.result.createObjectStore(HANDOFF_STORE);
    };
    req.onerror = () => reject(req.error || new Error("Could not reach the AudioSaw handoff."));
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction(HANDOFF_STORE, "readwrite");
        tx.objectStore(HANDOFF_STORE).put({ name, blob, from: "stemflipper" }, "pending");
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      } catch (e) {
        db.close();
        reject(e as Error);
      }
    };
  });
}

export function openEditor(): void {
  location.href = `${EDITOR_PATH}?from=stemflipper`;
}

/** Where a single stem can usefully go. */
export const SINGLE_TRACK_TARGETS = [
  { path: "/audio-editor", label: "the multitrack editor" },
  { path: "/audio-cutter", label: "the cutter" },
  { path: "/audio-eq", label: "the EQ" },
  { path: "/pitch-shifter", label: "the pitch shifter" },
];
