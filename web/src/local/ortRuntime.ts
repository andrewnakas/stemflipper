/**
 * onnxruntime-web, loaded once for whichever engine is running.
 *
 * This module is worker-only: it reads the `ort` global that `local.worker.ts` brings in
 * with importScripts. It is imported for its types on the main thread nowhere — keep it
 * that way, because touching `ort` outside the worker would drag the runtime into the page
 * bundle.
 */

import type * as ORT from "onnxruntime-web";
import { MODEL_CACHE } from "./engines";

/** Matches the onnxruntime-web version in package.json; the wasm must not drift from it. */
export const ORT_WASM_BASE = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.0/dist/";
export const ORT_SCRIPT = `${ORT_WASM_BASE}ort.webgpu.min.js`;


/** Set by the worker after importScripts. */
declare const ort: typeof ORT;

export type StatusFn = (phase: string, pct: number, detail: string) => void;

let envReady = false;
function ensureEnv(): void {
  if (envReady) return;
  ort.env.wasm.wasmPaths = ORT_WASM_BASE;
  ort.env.wasm.simd = true;
  ort.env.logLevel = "error";
  envReady = true;
}

/** Cached model bytes, keyed by URL. Survives reloads; ~100 MB class downloads. */
export async function fetchModel(url: string, label: string, status: StatusFn): Promise<Uint8Array> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open(MODEL_CACHE);
  } catch {
    /* private browsing */
  }
  if (cache) {
    const hit = await cache.match(url);
    if (hit) {
      status("model", 100, `${label} is already on this device`);
      return new Uint8Array(await hit.arrayBuffer());
    }
  }

  status("model", 0, `Downloading ${label}…`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download the model (HTTP ${res.status})`);
  const total = Number(res.headers.get("content-length") || 0);
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    chunks.push(r.value);
    received += r.value.length;
    status(
      "model",
      total ? (received / total) * 100 : 0,
      `Downloading ${label} — ${(received / 1048576).toFixed(0)}${total ? ` of ${(total / 1048576).toFixed(0)}` : ""} MB`,
    );
  }
  const bytes = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.length;
  }
  if (cache) {
    try {
      await cache.put(url, new Response(bytes));
    } catch {
      /* storage quota */
    }
  }
  return bytes;
}

export interface SessionResult {
  session: ORT.InferenceSession;
  backend: string;
  threads: number;
}

/**
 * Prefer the GPU, fall back to WASM.
 *
 * Threads are set per path deliberately: on the WebGPU path the compute is on the GPU, so a
 * WASM thread pool buys nothing — and spinning one up inside an already-nested worker
 * stalls session creation for minutes. Only the CPU path asks. Threads themselves only work
 * when the page is cross-origin isolated, which needs COOP/COEP headers from the host.
 */
export async function createSession(bytes: Uint8Array, wantGpu = true): Promise<SessionResult> {
  ensureEnv();
  if (wantGpu && (navigator as { gpu?: unknown }).gpu) {
    try {
      ort.env.wasm.numThreads = 1;
      const session = await ort.InferenceSession.create(bytes, { executionProviders: ["webgpu"] });
      return { session, backend: "webgpu", threads: 0 };
    } catch {
      /* fall through to the CPU path */
    }
  }
  ort.env.wasm.numThreads = self.crossOriginIsolated
    ? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1))
    : 1;
  const session = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"] });
  return { session, backend: "wasm", threads: ort.env.wasm.numThreads as number };
}

export function tensor(data: Float32Array, dims: number[]): ORT.Tensor {
  return new ort.Tensor("float32", data, dims);
}

export type { ORT };
