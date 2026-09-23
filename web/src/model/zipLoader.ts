/**
 * Opening a bundle zip that was already downloaded.
 *
 * The zip is the thing people keep — it is what they put in a DAW — so dropping it back
 * on the page should reopen the song, with no server involved. This also outlives the
 * six-hour bundle expiry on the Space: the zip on disk is the durable copy.
 */

import { unzipSync, type Unzipped } from "fflate";
import type { AssetSource } from "../api/assets";
import type { Project } from "./types";

export interface OpenedBundle {
  project: Project;
  source: AssetSource;
  /** Revoke every object URL this created. */
  dispose: () => void;
}

const MIME: Record<string, string> = {
  flac: "audio/flac",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  mid: "audio/midi",
  json: "application/json",
  vital: "application/json",
  sfz: "text/plain",
  dspreset: "application/xml",
  txt: "text/plain",
};

function mimeFor(path: string): string {
  return MIME[path.split(".").pop()?.toLowerCase() || ""] || "application/octet-stream";
}

export function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

/**
 * The pipeline zips the bundle inside a folder named after the song, so every path in
 * project.json is relative to that folder rather than the zip root. Find the common
 * prefix from where project.json actually sits instead of assuming either shape.
 */
export function bundlePrefix(names: string[]): string {
  const manifest = names.find((n) => n === "project.json" || n.endsWith("/project.json"));
  if (!manifest) return "";
  return manifest.slice(0, manifest.length - "project.json".length);
}

export function openBundle(bytes: Uint8Array): OpenedBundle {
  if (!looksLikeZip(bytes)) throw new Error("That file is not a zip.");

  let files: Unzipped;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error("That zip could not be read.");
  }

  const names = Object.keys(files);
  const prefix = bundlePrefix(names);
  const manifest = files[`${prefix}project.json`];
  if (!manifest) {
    throw new Error("That zip has no project.json — it does not look like a StemFlipper bundle.");
  }

  let project: Project;
  try {
    project = JSON.parse(new TextDecoder().decode(manifest)) as Project;
  } catch {
    throw new Error("That bundle's project.json is damaged.");
  }
  if (!Array.isArray(project.tracks)) throw new Error("That bundle's project.json has no tracks.");
  delete project._server;

  const urls: Record<string, string> = {};
  for (const name of names) {
    if (!name.startsWith(prefix) || name.endsWith("/")) continue;
    const rel = name.slice(prefix.length);
    if (!rel) continue;
    urls[rel] = URL.createObjectURL(new Blob([files[name]], { type: mimeFor(rel) }));
  }

  return {
    project,
    source: { kind: "blob", urls },
    dispose: () => {
      for (const url of Object.values(urls)) URL.revokeObjectURL(url);
    },
  };
}

export async function openBundleFile(file: File): Promise<OpenedBundle> {
  return openBundle(new Uint8Array(await file.arrayBuffer()));
}
