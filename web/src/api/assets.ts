/** Fetching and decoding bundle assets, from a backend or from the local fixture. */

import { apiRoot, type BackendConfig } from "./backend";

export interface AssetSource {
  /** Absolute bundle root on the backend, or a static base URL for the fixture. */
  kind: "server" | "static";
  backend?: BackendConfig;
  bundleRoot?: string;
  baseUrl?: string;
}

export function assetUrl(source: AssetSource, rel: string): string {
  const clean = rel.replace(/^\/+/, "");
  if (source.kind === "static") {
    return `${(source.baseUrl || "").replace(/\/+$/, "")}/${clean}`;
  }
  const abs = `${(source.bundleRoot || "").replace(/\/+$/, "")}/${clean}`;
  return `${apiRoot(source.backend!)}/file=${encodeURI(abs)}`;
}

const bytesCache = new Map<string, Promise<ArrayBuffer>>();

export function fetchBytes(url: string): Promise<ArrayBuffer> {
  let hit = bytesCache.get(url);
  if (!hit) {
    hit = fetch(url, { credentials: "omit" }).then((r) => {
      if (!r.ok) throw new Error(`${r.status} fetching ${url}`);
      return r.arrayBuffer();
    });
    bytesCache.set(url, hit);
  }
  return hit;
}

const audioCache = new Map<string, Promise<AudioBuffer>>();

/**
 * Decode an asset to an AudioBuffer.
 *
 * Stems are downmixed to mono by default: a 6-stem, 8-minute song is ~1 GB of stereo
 * float in the browser, and the mixer pans each track anyway.
 */
export async function decodeAudio(
  ctx: BaseAudioContext,
  url: string,
  opts: { mono?: boolean } = {},
): Promise<AudioBuffer> {
  const key = `${url}|${opts.mono !== false ? "mono" : "stereo"}`;
  let hit = audioCache.get(key);
  if (!hit) {
    hit = fetchBytes(url)
      .then((bytes) => ctx.decodeAudioData(bytes.slice(0)))
      .then((buf) => (opts.mono !== false ? toMono(ctx, buf) : buf));
    audioCache.set(key, hit);
  }
  return hit;
}

function toMono(ctx: BaseAudioContext, buf: AudioBuffer): AudioBuffer {
  if (buf.numberOfChannels === 1) return buf;
  const out = ctx.createBuffer(1, buf.length, buf.sampleRate);
  const dst = out.getChannelData(0);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const src = buf.getChannelData(c);
    for (let i = 0; i < src.length; i++) dst[i] += src[i] / buf.numberOfChannels;
  }
  return out;
}

export async function fetchJson<T>(url: string): Promise<T> {
  const bytes = await fetchBytes(url);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

export function releaseAudio(url?: string): void {
  if (!url) {
    audioCache.clear();
    bytesCache.clear();
    return;
  }
  for (const key of [...audioCache.keys()]) if (key.startsWith(url)) audioCache.delete(key);
  bytesCache.delete(url);
}
