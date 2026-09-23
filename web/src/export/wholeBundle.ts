/**
 * Build the whole bundle as a zip, in the browser.
 *
 * The server hands back a ready-made zip, but a demo, a song kept on this device and a run
 * done in the browser have no server to ask — and those were left with no way to take
 * everything at once, only file-by-file links.
 */

import { zip, type AsyncZippable } from "fflate";
import { assetUrl, fetchBytes, fetchJson, type AssetSource } from "../api/assets";
import { allBundlePaths } from "../model/bundle";
import type { Project } from "../model/types";

/** Audio is already compressed (or nearly), so deflating it costs time and saves little. */
function levelFor(path: string): 0 | 6 {
  return /\.(flac|wav|mp3|ogg|m4a|zip)$/i.test(path) ? 0 : 6;
}

export interface ZipProgress {
  done: number;
  total: number;
  bytes: number;
}

export async function zipWholeBundle(
  project: Project,
  source: AssetSource,
  onProgress?: (p: ZipProgress) => void,
): Promise<Blob> {
  const paths = await allBundlePaths(project, (rel) => fetchJson(assetUrl(source, rel)));

  const files: AsyncZippable = {};
  let bytes = 0;
  let done = 0;

  for (const rel of paths) {
    try {
      const buf = await fetchBytes(assetUrl(source, rel));
      files[rel] = [new Uint8Array(buf), { level: levelFor(rel) }];
      bytes += buf.byteLength;
    } catch {
      // A file that has expired or 404s should not lose the visitor the rest of the zip.
    }
    onProgress?.({ done: ++done, total: paths.length, bytes });
  }

  // project.json last, and from memory: it carries any note edits made since loading.
  const json = JSON.stringify({ ...project, _server: undefined });
  files["project.json"] = [new TextEncoder().encode(json), { level: 6 }];

  return new Promise((resolve, reject) => {
    zip(files, { level: 6 }, (err, data) => {
      if (err) reject(new Error(`Could not build the zip: ${err.message}`));
      else resolve(new Blob([new Uint8Array(data)], { type: "application/zip" }));
    });
  });
}
