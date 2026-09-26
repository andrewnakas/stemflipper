/**
 * Running one song, start to finish.
 *
 * Owns the side effects — upload, queue, stream, asset load — and feeds every outcome
 * through the pure reducer in job.ts, so the screens only ever read one typed phase.
 */

import { signal } from "@preact/signals";
import { assetUrl, fetchJson, type AssetSource } from "../api/assets";
import {
  cancelRun, fileUrl, joinQueue, sessionHash, streamResult, uploadFileWithProgress,
  type BackendConfig,
} from "../api/backend";
import { fetchSpaceStatus, isHostedSpace, wakePing, waitUntilAwake } from "../api/space";
import { resumeAudio } from "../engine/context";
import { BUNDLE_TTL_H, type Preset } from "../config";
import { navigate } from "../ui/router";
import { effectiveToken, tier } from "./auth";
import { classifyError, isJobError, reduce, type FileMeta, type JobEvent, type JobError, type JobPhase, type JobResult, type Step } from "./job";
import { applyMixerNow, openProject } from "./playback";
import { getSong, releaseSource, saveSong, sourceFor } from "./persist";
import { openBundleFile } from "./zipLoader";
import { preflight } from "./preflight";
import { estimateWallSeconds, pickPreset } from "./quota";
import { localEngineFor, localEstimateSeconds, preferLocal } from "../local/capability";
import { DEFAULT_ENGINE, type LocalEngine } from "../local/engines";
import { backend, mixer, notesByTrack, spaceId } from "./store";
import type { Project } from "./types";

export const job = signal<JobPhase>({ kind: "idle" });
export type RunWhere = "browser" | "server";

export const options = signal<{
  preset: Preset;
  six: boolean;
  presetTouched: boolean;
  where: RunWhere;
  engine: LocalEngine;
  /**
   * Set once someone picks where to run or which engine to use. Without it the next
   * `pickFile` silently overwrote an explicit choice — the old code guarded on
   * `presetTouched`, which is a different question and left `where` sticky only if you
   * happened to touch the preset first.
   */
  whereTouched: boolean;
}>({
  preset: "balanced",
  six: false,
  presetTouched: false,
  // Decided per device and per song in pickFile: local is unlimited and private, and with
  // the four-stem engine it costs roughly the song's own length — less on a GPU, a little
  // more on a single core.
  where: "server",
  engine: DEFAULT_ENGINE,
  whereTouched: false,
});

export function setWhere(where: RunWhere): void {
  options.value = { ...options.value, where, whereTouched: true };
}

export function setEngine(engine: LocalEngine): void {
  options.value = { ...options.value, engine, whereTouched: true };
}

/** Every phase the current run passed through — the smoke test asserts on this. */
export const jobLog = signal<string[]>([]);

export interface Attribution {
  title: string;
  artist: string;
  license: string;
  licenseUrl: string;
  sourceUrl: string;
  note?: string;
}

/** Set when the loaded project is a demo someone else made the music for. */
export const attribution = signal<Attribution | null>(null);

/**
 * A FINISHED run, so a reload can offer it again while the server still has the bundle.
 *
 * There is deliberately no equivalent for a run in progress: whether the Gradio queue
 * replays a stream to a returning session_hash is unverified, and offering a "reconnect"
 * that silently does nothing would be worse than saying a reload loses the run.
 */
const RESULT_KEY = "sf.result";

let controller: AbortController | null = null;
let ticker = 0;
let expectedS = 60;
let lastFile: File | null = null;
let currentSession: { hash: string; eventId: string | null; cfg: BackendConfig } | null = null;

function dispatch(ev: JobEvent): void {
  const next = reduce(job.value, ev, { expectedS });
  if (next !== job.value) {
    if (next.kind !== job.value.kind) jobLog.value = [...jobLog.value, next.kind];
    job.value = next;
  }
}

function cfgNow(): BackendConfig {
  return { baseUrl: backend.value.baseUrl, token: effectiveToken() };
}

/** Choose the preset for this file unless the visitor already picked one. */
export function suggestPreset(meta: FileMeta): void {
  if (options.value.presetTouched) return;
  options.value = { ...options.value, preset: pickPreset(meta.durationS ?? 210, tier()) };
}

export function setPreset(preset: Preset): void {
  options.value = { ...options.value, preset, presetTouched: true };
}

export function setSix(six: boolean): void {
  options.value = { ...options.value, six };
}

/**
 * Inspect a dropped file and show it, without starting anything.
 *
 * A .zip is a bundle someone downloaded earlier, not a song to process — opening it is
 * free, instant and works with no server at all, so it takes precedence.
 */
export async function pickFile(file: File): Promise<void> {
  if (/\.zip$/i.test(file.name) || file.type === "application/zip") {
    await openZip(file);
    return;
  }
  lastFile = file;
  jobLog.value = [];
  const { meta, problem } = await preflight(file);
  if (problem) {
    dispatch({ type: "fail", error: problem });
    navigate("run");
    return;
  }
  dispatch({ type: "pick", file: meta });
  suggestPreset(meta);
  if (!options.value.whereTouched) {
    const seconds = meta.durationS ?? 210;
    options.value = {
      ...options.value,
      where: preferLocal(seconds) ? "browser" : "server",
      engine: localEngineFor(seconds),
    };
  }
  navigate("run");
}

/**
 * Run the whole thing on this machine: no account, no queue, no daily limit, and the
 * audio never leaves the device. Four stems by default; no samples — that part needs the
 * server. Which engine runs is `options.value.engine`; see `local/engines.ts`.
 */
export async function startLocalJob(file: File): Promise<void> {
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;
  lastFile = file;
  jobLog.value = [];
  attribution.value = null;
  void resumeAudio();

  const STEPS: Record<string, Step> = {
    decode: "load",
    analyse: "analyze",
    model: "separate",
    separate: "separate",
    transcribe: "transcribe",
    assemble: "package",
  };

  try {
    const { meta, problem } = await preflight(file);
    if (problem) throw problem;
    dispatch({ type: "pick", file: meta });
    const engine = options.value.engine;
    expectedS = localEstimateSeconds(meta.durationS ?? 210, undefined, engine);

    const { runLocally } = await import("../local/pipeline");
    const result = await runLocally(
      file,
      (p) =>
        dispatch({
          type: "local",
          step: STEPS[p.phase] ?? "separate",
          pct: p.pct == null ? null : p.pct / 100,
          desc: p.detail,
          now: Date.now(),
        }),
      signal,
      engine,
    );

    releaseCurrentBlobSource();
    blobSource = result.dispose;
    dispatch({ type: "assets", loaded: 0, total: 0 });
    await openProject(result.project, result.source, (loaded, total) =>
      dispatch({ type: "assets", loaded, total }),
    );
    dispatch({
      type: "ready",
      result: { project: result.project, source: result.source, zipUrl: null, zipBytes: null, expiresAt: null },
    });
    navigate("listen");
  } catch (e) {
    if (signal.aborted && !isJobError(e)) return;
    dispatch({ type: "fail", error: isJobError(e) ? e : classifyError(e) });
  }
}

export function reset(): void {
  controller?.abort();
  controller = null;
  stopTicker();
  lastFile = null;
  currentSession = null;
  dispatch({ type: "reset" });
}

export function cancelJob(): void {
  controller?.abort();
  if (currentSession) void cancelRun(currentSession.cfg, currentSession.hash, currentSession.eventId);
  stopTicker();
  dispatch({ type: "fail", error: { code: "cancelled", message: "Cancelled.", recovery: ["retry"] } });
}

export function retry(): void {
  startPending();
}

/** Start the file the visitor already chose. Must be called from their click. */
export function startPending(): void {
  if (!lastFile) return;
  if (options.value.where === "browser") void startLocalJob(lastFile);
  else void startJob(lastFile);
}

export function hasPendingFile(): boolean {
  return lastFile !== null;
}

function startTicker(): void {
  stopTicker();
  ticker = window.setInterval(() => dispatch({ type: "tick", now: Date.now() }), 250);
}

function stopTicker(): void {
  if (ticker) window.clearInterval(ticker);
  ticker = 0;
}

/**
 * The whole run. Must be called from a user gesture: resumeAudio() only unlocks audio
 * inside one, and Safari will otherwise leave the context suspended until the first tap.
 */
export async function startJob(file: File): Promise<void> {
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;
  lastFile = file;
  jobLog.value = [];
  attribution.value = null;
  void resumeAudio();

  try {
    const { meta, problem } = await preflight(file);
    if (problem) throw problem;
    dispatch({ type: "pick", file: meta });
    suggestPreset(meta);

    const { preset, six } = options.value;
    expectedS = estimateWallSeconds(meta.durationS ?? 210, preset, six);
    const cfg = cfgNow();

    await ensureAwake(cfg, signal);

    dispatch({ type: "upload", pct: 0 });
    const ref = await uploadFileWithProgress(cfg, file, (pct) => dispatch({ type: "upload", pct }), signal);

    const hash = sessionHash();
    const { event_id } = await joinQueue(cfg, ref, { preset, six }, hash, signal);
    currentSession = { hash, eventId: event_id, cfg };

    startTicker();
    const data = await streamResult(cfg, hash, () => undefined, 3, signal, (msg) =>
      dispatch({ type: "gradio", msg, now: Date.now() }),
    );
    stopTicker();

    await finish(data, cfg);
  } catch (e) {
    stopTicker();
    if (signal.aborted && !isJobError(e)) return; // cancelJob already reported it
    dispatch({ type: "fail", error: isJobError(e) ? e : classifyError(e) });
  }
}

/** Wake a sleeping Space before uploading into it, so the wait is explained. */
async function ensureAwake(cfg: BackendConfig, signal: AbortSignal): Promise<void> {
  if (!isHostedSpace(cfg.baseUrl)) return; // a local backend is always awake
  let status;
  try {
    status = await fetchSpaceStatus(spaceId, signal);
  } catch {
    return; // Hub unreachable: just try the upload
  }
  if (status.awake) return;
  if (!status.willWake) {
    const stage = status.stage.toLowerCase().replace(/_/g, " ");
    throw { code: "sleeping", message: `The processing server is ${stage} and cannot run right now.`, recovery: ["demo", "retry"] } as JobError;
  }
  dispatch({ type: "wake", stage: status.stage, now: Date.now() });
  wakePing(cfg.baseUrl);
  const woke = await waitUntilAwake(spaceId, {
    signal,
    onStage: (stage) => dispatch({ type: "wake", stage, now: Date.now() }),
  });
  if (!woke) {
    throw { code: "sleeping", message: "The processing server did not wake up in time.", recovery: ["retry", "demo"] } as JobError;
  }
}

/** Turn the flip outputs into a loaded, playable project. */
async function finish(data: unknown[], cfg: BackendConfig): Promise<void> {
  const project = data[3] as Project | undefined;
  if (!project || !Array.isArray(project.tracks)) {
    throw new Error("The server finished but did not return a project.");
  }
  const zip = data[0] as { url?: string; size?: number } | undefined;
  const source: AssetSource = {
    kind: "server",
    backend: cfg,
    bundleRoot: project._server?.bundle_root || "",
  };
  const result: JobResult = {
    project,
    source,
    zipUrl: fileUrl(cfg, zip),
    zipBytes: typeof zip?.size === "number" ? zip.size : null,
    expiresAt: Date.now() + BUNDLE_TTL_H * 3600 * 1000,
  };
  rememberResult(result, cfg);

  dispatch({ type: "assets", loaded: 0, total: 0 });
  await openProject(project, source, (loaded, total) => dispatch({ type: "assets", loaded, total }));
  dispatch({ type: "ready", result });
  navigate("listen");
}

/** Open a finished bundle straight off the backend (?bundle=… or a reload). */
export async function openBundle(bundleRoot: string, cfg: BackendConfig = cfgNow()): Promise<void> {
  const source: AssetSource = { kind: "server", backend: cfg, bundleRoot };
  const project = await fetchJson<Project>(assetUrl(source, "project.json"));
  dispatch({ type: "assets", loaded: 0, total: 0 });
  await openProject(project, source, (loaded, total) => dispatch({ type: "assets", loaded, total }));
  const saved = readResult();
  dispatch({
    type: "ready",
    result: {
      project,
      source,
      zipUrl: saved?.bundleRoot === bundleRoot ? saved.zipUrl : null,
      zipBytes: saved?.bundleRoot === bundleRoot ? saved.zipBytes : null,
      expiresAt: saved?.bundleRoot === bundleRoot ? saved.expiresAt : null,
    },
  });
  navigate("listen");
}

/** Open a static fixture (the demo, or a CI bundle). */
export async function openFixture(name: string): Promise<void> {
  const baseUrl = `${import.meta.env.BASE_URL}fixtures/${name}`.replace(/\/+$/, "");
  const source: AssetSource = { kind: "static", baseUrl };
  const project = await fetchJson<Project>(`${baseUrl}/project.json`);
  // Someone else wrote the music; credit them wherever it plays.
  attribution.value = await fetchJson<Attribution>(`${baseUrl}/attribution.json`).catch(() => null);
  dispatch({ type: "assets", loaded: 0, total: 0 });
  await openProject(project, source, (loaded, total) => dispatch({ type: "assets", loaded, total }));
  dispatch({ type: "ready", result: { project, source, zipUrl: null, zipBytes: null, expiresAt: null } });
  navigate("listen");
}

/** Reopen a bundle zip the visitor already has. */
export async function openZip(file: File): Promise<void> {
  try {
    const opened = await openBundleFile(file);
    attribution.value = null;
    releaseCurrentBlobSource();
    blobSource = opened.dispose;
    dispatch({ type: "assets", loaded: 0, total: 0 });
    await openProject(opened.project, opened.source, (loaded, total) =>
      dispatch({ type: "assets", loaded, total }),
    );
    dispatch({
      type: "ready",
      result: { project: opened.project, source: opened.source, zipUrl: null, zipBytes: file.size, expiresAt: null },
    });
    navigate("listen");
  } catch (e) {
    dispatch({ type: "fail", error: classifyError(e) });
    navigate("run");
  }
}

/** Reopen a song kept in this browser. */
export async function openSaved(id: string): Promise<void> {
  const song = await getSong(id);
  if (!song) throw new Error("That song is no longer stored in this browser.");
  const source = sourceFor(song);
  releaseCurrentBlobSource();
  blobSource = () => releaseSource(source);
  attribution.value = song.attribution;
  dispatch({ type: "assets", loaded: 0, total: 0 });
  await openProject(song.project, source, (loaded, total) => dispatch({ type: "assets", loaded, total }));
  if (song.mixer) mixer.value = song.mixer as typeof mixer.value;
  applyMixerNow();
  dispatch({
    type: "ready",
    result: { project: song.project, source, zipUrl: null, zipBytes: song.bytes, expiresAt: null },
  });
  navigate("listen");
}

/** Store the current song so it survives the bundle expiring on the server. */
export async function keepCurrent(onProgress?: (done: number, total: number) => void): Promise<void> {
  const phase = job.value;
  if (phase.kind !== "ready") throw new Error("There is nothing loaded to keep.");
  await saveSong(
    phase.result.project,
    phase.result.source,
    notesByTrack.value,
    mixer.value,
    attribution.value,
    onProgress,
  );
}

/** Object URLs from a previously opened blob bundle. */
let blobSource: (() => void) | null = null;
function releaseCurrentBlobSource(): void {
  blobSource?.();
  blobSource = null;
}

function rememberResult(result: JobResult, cfg: BackendConfig): void {
  try {
    sessionStorage.setItem(
      RESULT_KEY,
      JSON.stringify({
        bundleRoot: result.source.bundleRoot,
        baseUrl: cfg.baseUrl,
        zipUrl: result.zipUrl,
        zipBytes: result.zipBytes,
        expiresAt: result.expiresAt,
        name: result.project.song.source_file,
      }),
    );
  } catch {
    /* ignore */
  }
}

export interface SavedResult {
  bundleRoot: string;
  baseUrl: string;
  zipUrl: string | null;
  zipBytes: number | null;
  expiresAt: number | null;
  name: string;
}

export function readResult(): SavedResult | null {
  try {
    const raw = sessionStorage.getItem(RESULT_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as SavedResult;
    if (saved.expiresAt && saved.expiresAt < Date.now()) {
      sessionStorage.removeItem(RESULT_KEY);
      return null;
    }
    return saved;
  } catch {
    return null;
  }
}
