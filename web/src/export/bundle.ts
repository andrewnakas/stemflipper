/** Client-side export: edited MIDI, rendered audio and the updated project, as one zip. */

import { zipSync, type Zippable } from "fflate";
import type { AssetSource } from "../api/assets";
import { renderMix } from "../engine/render";
import type { MixerState } from "../engine/graph";
import type { Note, Project } from "../model/types";
import { rowsFromNotes } from "../model/types";
import { writeMidi } from "./midi";
import { encodeWav } from "./wav";

export interface ExportOptions {
  midi: boolean;
  mix: boolean;
  stems: boolean;
  bits?: 16 | 24;
  onProgress?: (message: string) => void;
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

export async function buildExportZip(
  project: Project,
  source: AssetSource,
  mixer: MixerState,
  notesByTrack: Record<string, Note[]>,
  opts: ExportOptions,
): Promise<Blob> {
  const files: Zippable = {};
  const say = opts.onProgress || (() => undefined);

  if (opts.midi) {
    say("Writing MIDI…");
    const tracks = project.tracks.map((t) => ({
      name: t.id,
      isDrum: t.kind === "drums",
      notes: notesByTrack[t.id] || [],
    }));
    files["midi/song.mid"] = writeMidi(tracks, project.grid, project.sections);
    for (const t of tracks) {
      if (t.notes.length) files[`midi/${t.name}.mid`] = writeMidi([t], project.grid, project.sections);
    }
  }

  if (opts.mix) {
    say("Rendering the mix…");
    const buf = await renderMix(project, source, mixer, notesByTrack);
    files["render/mix.wav"] = await blobBytes(encodeWav(buf, opts.bits || 16));
  }

  if (opts.stems) {
    for (const track of project.tracks) {
      say(`Rendering ${track.id}…`);
      const solo: MixerState = {
        ...mixer,
        solo: Object.fromEntries(project.tracks.map((t) => [t.id, t.id === track.id])),
      };
      const buf = await renderMix(project, source, solo, notesByTrack);
      files[`render/${track.id}.wav`] = await blobBytes(encodeWav(buf, opts.bits || 16));
    }
  }

  // the project as edited, so a re-import picks up the corrected notes
  const edited: Project = {
    ...project,
    tracks: project.tracks.map((t) => ({
      ...t,
      notes: rowsFromNotes(notesByTrack[t.id] || []),
      transcription: { ...t.transcription, n_notes: (notesByTrack[t.id] || []).length },
    })),
  };
  delete (edited as { _server?: unknown })._server;
  files["project.json"] = new TextEncoder().encode(JSON.stringify({ ...edited, edited: true }, null, 2));

  say("Zipping…");
  return new Blob([zipSync(files, { level: 6 })], { type: "application/zip" });
}
