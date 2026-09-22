/**
 * Check a file in the browser before spending the visitor's upload and GPU quota on it.
 *
 * Duration comes from an <audio preload="metadata"> on a blob URL rather than hand-rolled
 * header parsing. The browser sniffs the real container, so it gets the right answer for
 * the case that actually broke a live upload once — AAC data inside a file named .mp3 —
 * where a parser trusting the extension would not. If the browser cannot read it at all we
 * let the upload through with an unknown duration: the server has ffmpeg and may well
 * succeed, and refusing here would be us guessing.
 */

import { LIMITS } from "../config";
import type { FileMeta, JobError } from "./job";

export function fileMeta(file: File, durationS: number | null = null): FileMeta {
  return { name: file.name, bytes: file.size, durationS, type: file.type || "" };
}

function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i).toLowerCase();
}

/** Pure part: everything knowable without decoding. */
export function validateMeta(meta: FileMeta): JobError | null {
  if (meta.bytes === 0) {
    return { code: "bad_format", message: "That file is empty.", recovery: ["pick_another"] };
  }
  if (meta.bytes > LIMITS.maxBytes) {
    const mb = (meta.bytes / 1e6).toFixed(0);
    const cap = (LIMITS.maxBytes / 1e6).toFixed(0);
    return {
      code: "too_big",
      message: `That file is ${mb} MB and the upload limit is ${cap} MB.`,
      recovery: ["compress", "trim", "pick_another"],
    };
  }
  const ext = extensionOf(meta.name);
  const looksAudio = meta.type.startsWith("audio/") || meta.type.startsWith("video/");
  if (ext && !LIMITS.extensions.includes(ext) && !looksAudio) {
    return {
      code: "bad_format",
      message: `${ext} is not an audio format this accepts.`,
      detail: `Accepted: ${LIMITS.extensions.join(" ")}`,
      recovery: ["convert", "pick_another"],
    };
  }
  if (meta.durationS != null && meta.durationS > LIMITS.maxMinutes * 60) {
    const mins = (meta.durationS / 60).toFixed(1);
    return {
      code: "too_long",
      message: `That song is ${mins} minutes and the limit is ${LIMITS.maxMinutes}.`,
      recovery: ["trim", "pick_another"],
    };
  }
  if (meta.durationS != null && meta.durationS > 0 && meta.durationS < 1) {
    return { code: "bad_format", message: "That clip is under a second long.", recovery: ["pick_another"] };
  }
  return null;
}

/** Ask the browser how long the file is. Resolves null when it cannot tell. */
export function probeDuration(file: File, timeoutMs = 10_000): Promise<number | null> {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    let settled = false;
    const done = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    audio.onloadedmetadata = () => {
      const d = audio.duration;
      done(Number.isFinite(d) && d > 0 ? d : null);
    };
    audio.onerror = () => done(null);
    audio.src = url;
  });
}

export interface Preflight {
  meta: FileMeta;
  problem: JobError | null;
}

export async function preflight(file: File): Promise<Preflight> {
  const quick = validateMeta(fileMeta(file));
  // Do not spend time decoding something already rejected on size or type.
  if (quick && quick.code !== "too_long") return { meta: fileMeta(file), problem: quick };
  const durationS = await probeDuration(file);
  const meta = fileMeta(file, durationS);
  return { meta, problem: validateMeta(meta) };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1e6) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1e6).toFixed(1)} MB`;
}

export function formatDuration(s: number | null): string {
  if (s == null) return "unknown length";
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}
