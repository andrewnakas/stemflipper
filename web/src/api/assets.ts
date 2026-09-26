/** Fetching and decoding bundle assets, from a backend or from the local fixture. */

import { apiRoot, type BackendConfig } from "./backend";

export interface AssetSource {
  /**
   * "server"  — a bundle sitting on the backend that produced it
   * "static"  — a fixture served from this site
   * "blob"    — a bundle unzipped in the browser (a saved project, or a dropped zip),
   *             each asset already an object URL
   */
  kind: "server" | "static" | "blob";
  backend?: BackendConfig;
  bundleRoot?: string;
  baseUrl?: string;
  urls?: Record<string, string>;
}

export function assetUrl(source: AssetSource, rel: string): string {
  const clean = rel.replace(/^\/+/, "");
  if (source.kind === "blob") return source.urls?.[clean] || "";
  if (source.kind === "static") {
    return `${(source.baseUrl || "").replace(/\/+$/, "")}/${clean}`;
  }
  const abs = `${(source.bundleRoot || "").replace(/\/+$/, "")}/${clean}`;
  return `${apiRoot(source.backend!)}/file=${encodeURI(abs)}`;
}

const bytesCache = new Map<string, Promise<ArrayBuffer>>();

/**
 * Asset-load progress.
 *
 * Loading a bundle is often the longest visible wait after the job finishes — tens of MB
 * of FLAC, plus every sampler zone — and v2 showed one static line for all of it. Counting
 * here, at the single choke point every asset fetch goes through, means the screens get a
 * real n-of-total without the engine knowing anything about the UI.
 */
type AssetListener = (loaded: number, total: number) => void;
let assetListener: AssetListener | null = null;
let assetsStarted = 0;
let assetsFinished = 0;

export function trackAssets(cb: AssetListener | null): void {
  assetListener = cb;
  assetsStarted = 0;
  assetsFinished = 0;
}

function assetProgress(): void {
  assetListener?.(assetsFinished, assetsStarted);
}

export function fetchBytes(url: string): Promise<ArrayBuffer> {
  let hit = bytesCache.get(url);
  if (!hit) {
    assetsStarted++;
    assetProgress();
    hit = fetch(url, { credentials: "omit" })
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} fetching ${url}`);
        return r.arrayBuffer();
      })
      .finally(() => {
        assetsFinished++;
        assetProgress();
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
  // The sample rate belongs in the key. An AudioBuffer plays at its CONTEXT's rate, so a
  // stem decoded by the live 48 kHz AudioContext and then reused by a 44.1 kHz
  // OfflineAudioContext for an export came out 8.8% slow and a semitone and a half flat.
  const key = `${url}|${opts.mono !== false ? "mono" : "stereo"}|${ctx.sampleRate}`;
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
