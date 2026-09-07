/**
 * StemFlipper backend client — the Space's Gradio queue REST API, or the same app.py
 * running locally (`python app.py` → http://127.0.0.1:7860).
 *
 * NO @gradio/client (Invariant #10): its fetches use credentials:"include" and HF Spaces
 * omits Access-Control-Allow-Credentials on the *preflight*, so a cross-origin call from
 * github.io is blocked. We drive /upload, /queue/join and /queue/data directly with
 * credentials:"omit", which the Space's CORS does permit.
 */

import { readSse } from "./sse";

export interface BackendConfig {
  /** e.g. https://nakas-stemflipper.hf.space or http://127.0.0.1:7860 */
  baseUrl: string;
  /** Optional HF token so ZeroGPU quota is billed to the user, not the anonymous pool. */
  token?: string | null;
}

export interface FlipOptions {
  preset: "fast" | "balanced" | "best";
  six?: boolean;
}

export type ProgressFn = (message: string, fraction?: number) => void;

export interface FileRef {
  path: string;
  orig_name: string;
  meta: { _type: "gradio.FileData" };
}

const FN_INDEX = 0; // the "flip" endpoint

export function spaceUrl(space: string): string {
  return "https://" + space.replace("/", "-") + ".hf.space";
}

export function apiRoot(cfg: BackendConfig): string {
  return cfg.baseUrl.replace(/\/+$/, "") + "/gradio_api";
}

function headers(cfg: BackendConfig, extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...(extra || {}) };
  if (cfg.token) h["authorization"] = `Bearer ${cfg.token}`;
  return h;
}

export function sessionHash(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

/** A Gradio FileData reference (or bare path) → an absolute, downloadable URL. */
export function fileUrl(cfg: BackendConfig, fd: unknown): string | null {
  if (!fd) return null;
  if (typeof fd === "string") return fd;
  const o = fd as { url?: string; path?: string };
  if (o.url) return o.url;
  if (o.path) return `${apiRoot(cfg)}/file=${o.path}`;
  return null;
}

/** A bundle-relative asset path → an absolute URL on the backend that produced it. */
export function assetUrl(cfg: BackendConfig, bundleRoot: string, rel: string): string {
  const abs = `${bundleRoot.replace(/\/+$/, "")}/${rel.replace(/^\/+/, "")}`;
  return `${apiRoot(cfg)}/file=${encodeURI(abs)}`;
}

export async function uploadFile(cfg: BackendConfig, file: File, signal?: AbortSignal): Promise<FileRef> {
  const body = new FormData();
  body.append("files", file, file.name);
  const res = await fetch(`${apiRoot(cfg)}/upload`, {
    method: "POST",
    credentials: "omit",
    headers: headers(cfg),
    body,
    signal,
  });
  if (!res.ok) throw new Error(`upload failed (${res.status})`);
  const paths = (await res.json()) as string[];
  return { path: paths[0], orig_name: file.name, meta: { _type: "gradio.FileData" } };
}

/**
 * Run /flip and resolve with the output `data` array.
 *
 * JOIN FIRST, then open the result stream: opening the stream before the join has
 * registered the session_hash races the Gradio queue server, which replies
 * `session_not_found` and the job hangs (this bit us in v1).
 */
export async function runFlip(
  cfg: BackendConfig,
  fileRef: FileRef,
  opts: FlipOptions,
  onProgress: ProgressFn,
  signal?: AbortSignal,
): Promise<unknown[]> {
  const session_hash = sessionHash();
  const join = await fetch(`${apiRoot(cfg)}/queue/join`, {
    method: "POST",
    credentials: "omit",
    headers: headers(cfg, { "content-type": "application/json" }),
    body: JSON.stringify({
      data: [fileRef, opts.preset, !!opts.six],
      fn_index: FN_INDEX,
      session_hash,
      trigger_id: null,
    }),
    signal,
  });
  if (!join.ok) throw new Error(`queue join failed (${join.status})`);
  return streamResult(cfg, session_hash, onProgress, 3, signal);
}

export async function streamResult(
  cfg: BackendConfig,
  session_hash: string,
  onProgress: ProgressFn,
  retriesLeft = 3,
  signal?: AbortSignal,
): Promise<unknown[]> {
  const res = await fetch(`${apiRoot(cfg)}/queue/data?session_hash=${session_hash}`, {
    method: "GET",
    credentials: "omit",
    headers: headers(cfg, { accept: "text/event-stream" }),
    signal,
  });
  if (!res.ok) throw new Error(`result stream failed (${res.status})`);

  for await (const frame of readSse(res, signal)) {
    let msg: any;
    try {
      msg = JSON.parse(frame.data);
    } catch {
      continue;
    }
    switch (msg.msg) {
      case "estimation":
      case "process_starts":
        onProgress("Processing on the backend — keep this tab open.");
        break;
      case "progress": {
        const p = msg.progress_data && msg.progress_data[0];
        if (p) onProgress(`${p.desc || "processing"}${p.unit ? ` (${p.unit})` : ""}…`, p.progress ?? undefined);
        break;
      }
      case "process_completed":
        if (msg.success === false || (msg.output && msg.output.error)) {
          throw new Error((msg.output && msg.output.error) || "the backend reported an error");
        }
        return (msg.output && msg.output.data) || [];
      case "unexpected_error":
        if (msg.session_not_found && retriesLeft > 0) {
          await new Promise((r) => setTimeout(r, 500));
          return streamResult(cfg, session_hash, onProgress, retriesLeft - 1, signal);
        }
        throw new Error(msg.message || "the backend reported an unexpected error");
      case "close_stream":
        throw new Error("the backend closed the stream before returning a result");
    }
  }
  throw new Error("the result stream ended without a result");
}
