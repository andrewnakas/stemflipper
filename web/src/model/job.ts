/**
 * The upload → result job, as a state machine.
 *
 * v2 kept a single free-text `status` string, so the UI could not tell "queued behind
 * someone" from "separating" from "your quota ran out". Everything the Gradio stream
 * already carries is typed here instead, and `reduce` is pure so the whole flow can be
 * replayed in a test from frames recorded off the live Space
 * (test/fixtures/gradio_frames.jsonl).
 */

import type { AssetSource } from "../api/assets";
import type { Project } from "./types";

export type Step = "load" | "separate" | "analyze" | "transcribe" | "samples" | "package";

export const STEPS: { id: Step; label: string }[] = [
  { id: "load", label: "Reading the audio" },
  { id: "separate", label: "Separating stems" },
  { id: "analyze", label: "Finding tempo, key and chords" },
  { id: "transcribe", label: "Transcribing notes" },
  { id: "samples", label: "Building samples and instruments" },
  { id: "package", label: "Packaging the bundle" },
];

/**
 * Where each step sits on the server's own 0..1 progress scale (from pipeline.py's
 * progress calls). Used to smooth the bar: `separate` reports 0.08 and then says nothing
 * for most of the job, so without interpolation the bar looks stuck.
 */
export const STEP_BOUNDS: Record<Step, [number, number]> = {
  load: [0.0, 0.08],
  separate: [0.08, 0.42],
  analyze: [0.42, 0.45],
  transcribe: [0.45, 0.7],
  samples: [0.7, 0.9],
  package: [0.9, 1.0],
};

export type ErrorCode =
  | "quota"
  | "rate_limited"
  | "too_long"
  | "too_big"
  | "bad_format"
  | "undecodable"
  | "sleeping"
  | "network"
  | "cancelled"
  | "auth"
  | "backend";

export type Recovery = "sign_in" | "use_fast" | "wait" | "retry" | "trim" | "compress" | "paste_token" | "demo" | "pick_another";

export interface JobError {
  code: ErrorCode;
  /** Shown to the user. Already human-readable — never a raw stack or HTTP line. */
  message: string;
  /** Raw text from the backend, kept for the details disclosure. */
  detail?: string;
  requestedS?: number;
  leftS?: number;
  retryAfterS?: number;
  recovery: Recovery[];
}

export interface FileMeta {
  name: string;
  bytes: number;
  durationS: number | null;
  type: string;
}

export interface JobResult {
  project: Project;
  source: AssetSource;
  /** Direct download URL for the full bundle zip (data[0].url), when the run produced one. */
  zipUrl: string | null;
  zipBytes: number | null;
  expiresAt: number | null;
}

export type JobPhase =
  | { kind: "idle" }
  | { kind: "picked"; file: FileMeta }
  | { kind: "uploading"; file: FileMeta; pct: number }
  | { kind: "waking"; file: FileMeta; stage: string; since: number }
  | { kind: "queued"; file: FileMeta; rank: number; queueSize: number }
  | {
      kind: "running";
      file: FileMeta;
      step: Step;
      desc: string;
      /** Last fraction the server reported. */
      pct: number;
      /** Smoothed fraction for the bar; never goes backwards, never passes the next step. */
      shown: number;
      stepStartedAt: number;
      startedAt: number;
      expectedS: number;
    }
  | { kind: "loading"; file: FileMeta; loaded: number; total: number }
  | { kind: "ready"; result: JobResult }
  | { kind: "error"; error: JobError; file?: FileMeta };

export type JobEvent =
  | { type: "pick"; file: FileMeta }
  | { type: "upload"; pct: number }
  | { type: "wake"; stage: string; now: number }
  | { type: "gradio"; msg: GradioMsg; now: number }
  | { type: "assets"; loaded: number; total: number }
  | { type: "ready"; result: JobResult }
  | { type: "fail"; error: JobError }
  | { type: "tick"; now: number }
  | { type: "reset" };

/** The frames the Gradio queue sends. Only the fields we actually read are typed. */
export interface GradioMsg {
  msg: string;
  rank?: number;
  queue_size?: number;
  rank_eta?: number;
  progress_data?: { progress: number | null; desc?: string | null; index?: number | null; length?: number | null }[];
  output?: { data?: unknown[]; error?: string };
  success?: boolean;
  message?: string;
  session_not_found?: boolean;
}

/** Map a pipeline progress description to the step it belongs to. */
export function stepFromDesc(desc: string): Step {
  const d = desc.toLowerCase();
  if (d.startsWith("separating")) return "separate";
  if (d.startsWith("loading")) return "load";
  if (d.startsWith("analyzing tempo")) return "analyze";
  if (d.includes("transcrib")) return "transcribe";
  if (d.startsWith("building") || d.startsWith("reconstructing")) return "samples";
  if (d.startsWith("writing") || d.startsWith("zipping") || d === "done") return "package";
  return "separate";
}

export function stepIndex(step: Step): number {
  return STEPS.findIndex((s) => s.id === step);
}

/**
 * Ease the bar from where the step began toward where the next step starts, so a long
 * silent stage still moves. Asymptotic, so it slows down rather than stalling at a wall
 * or overshooting into a step that has not happened.
 */
function smooth(from: number, to: number, elapsedS: number, expectedS: number): number {
  const tau = Math.max(1, expectedS);
  const eased = from + (to - from) * (1 - Math.exp(-elapsedS / tau));
  return Math.min(to - 0.004, Math.max(from, eased));
}

export function reduce(phase: JobPhase, ev: JobEvent, ctx: { expectedS: number } = { expectedS: 60 }): JobPhase {
  switch (ev.type) {
    case "reset":
      return { kind: "idle" };

    case "pick":
      return { kind: "picked", file: ev.file };

    case "upload": {
      const file = fileOf(phase);
      if (!file) return phase;
      return { kind: "uploading", file, pct: ev.pct };
    }

    case "wake": {
      const file = fileOf(phase);
      if (!file) return phase;
      const since = phase.kind === "waking" ? phase.since : ev.now;
      return { kind: "waking", file, stage: ev.stage, since };
    }

    case "assets": {
      const file = fileOf(phase) || { name: "", bytes: 0, durationS: null, type: "" };
      return { kind: "loading", file, loaded: ev.loaded, total: ev.total };
    }

    case "ready":
      return { kind: "ready", result: ev.result };

    case "fail":
      return { kind: "error", error: ev.error, file: fileOf(phase) };

    case "tick": {
      if (phase.kind !== "running") return phase;
      const [start, end] = STEP_BOUNDS[phase.step];
      const elapsed = (ev.now - phase.stepStartedAt) / 1000;
      // Give each step a slice of the estimate proportional to its span of the bar.
      const stepBudget = Math.max(2, ctx.expectedS * (end - start));
      return { ...phase, shown: smooth(Math.max(phase.pct, phase.shown), end, elapsed, stepBudget) };
    }

    case "gradio":
      return reduceGradio(phase, ev.msg, ev.now, ctx);
  }
}

function reduceGradio(phase: JobPhase, msg: GradioMsg, now: number, ctx: { expectedS: number }): JobPhase {
  const file = fileOf(phase) || { name: "", bytes: 0, durationS: null, type: "" };

  switch (msg.msg) {
    case "estimation": {
      // rank 0 means "about to run", not "queued" — showing a queue for it would be a lie.
      // rank_eta is a fixed server-side guess (300 s for a 28 s job), so it is ignored.
      if ((msg.rank ?? 0) <= 0) return phase;
      return { kind: "queued", file, rank: msg.rank ?? 0, queueSize: msg.queue_size ?? 0 };
    }

    case "process_starts":
      return {
        kind: "running",
        file,
        step: "load",
        desc: "Reading the audio",
        pct: 0,
        shown: 0,
        stepStartedAt: now,
        startedAt: now,
        expectedS: ctx.expectedS,
      };

    case "progress": {
      const p = msg.progress_data?.[0];
      if (!p) return phase;
      const desc = p.desc || "";
      const step = stepFromDesc(desc);
      const pct = typeof p.progress === "number" ? p.progress : 0;
      const prev = phase.kind === "running" ? phase : null;
      const changedStep = !prev || prev.step !== step;
      return {
        kind: "running",
        file,
        step,
        desc,
        pct: Math.max(pct, prev?.pct ?? 0),
        shown: Math.max(pct, prev?.shown ?? 0),
        stepStartedAt: changedStep ? now : prev!.stepStartedAt,
        startedAt: prev?.startedAt ?? now,
        expectedS: ctx.expectedS,
      };
    }

    case "process_completed": {
      if (msg.success === false || msg.output?.error) {
        return { kind: "error", error: classifyError(msg.output?.error || "The backend reported an error."), file };
      }
      return phase; // the runner turns output.data into a JobResult and dispatches "ready"
    }

    case "unexpected_error":
      return {
        kind: "error",
        error: {
          code: "backend",
          message: msg.message || "The backend hit an unexpected error.",
          recovery: ["retry"],
        },
        file,
      };

    case "close_stream":
      return {
        kind: "error",
        error: {
          code: "network",
          message: "The connection to the server closed before the song was finished.",
          recovery: ["retry"],
        },
        file,
      };

    default: // heartbeat and anything new
      return phase;
  }
}

function fileOf(phase: JobPhase): FileMeta | undefined {
  return "file" in phase ? phase.file : undefined;
}

/** "0:05:03" / "5:03" → seconds. */
function parseClock(text: string): number | undefined {
  const m = text.match(/(\d+):(\d{2})(?::(\d{2}))?/);
  if (!m) return undefined;
  const parts = m[3] ? [m[1], m[2], m[3]] : ["0", m[1], m[2]];
  return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
}

/**
 * Turn whatever the backend said into something the user can act on.
 *
 * The ZeroGPU quota message is the one that matters most: it is the normal way a visitor
 * fails, and it carries the numbers needed to say "sign in" or "use Fast" instead of
 * printing a stack trace.
 */
export function classifyError(raw: unknown): JobError {
  const text = typeof raw === "string" ? raw : (raw as Error)?.message || String(raw);
  const t = text.toLowerCase();

  if (t.includes("gpu quota") || t.includes("gpu task aborted") || t.includes("exceeded your")) {
    // "(59s left vs. 60s requested)" and "(60s requested vs. 59s left)" both occur.
    const left = text.match(/(\d+)\s*s(?:econds)?\s*left/i);
    const requested = text.match(/(\d+)\s*s(?:econds)?\s*requested/i);
    const retry = /retry in|try again in/i.test(text) ? parseClock(text.split(/retry in|try again in/i)[1] || "") : undefined;
    const isPro = t.includes("pro gpu quota");
    return {
      code: "quota",
      message: "That would use more free GPU time than you have left today.",
      detail: text,
      leftS: left ? Number(left[1]) : undefined,
      requestedS: requested ? Number(requested[1]) : undefined,
      retryAfterS: retry,
      recovery: isPro ? ["use_fast", "wait"] : ["sign_in", "use_fast", "wait", "demo"],
    };
  }

  if (t.includes("ip-based quota") || t.includes("invalidrepotoken") || t.includes("invalid token") || t.includes("401")) {
    return {
      code: "auth",
      message: "Your Hugging Face sign-in was not accepted, so the shared anonymous quota was used.",
      detail: text,
      recovery: ["sign_in", "use_fast"],
    };
  }

  if (t.includes("keep songs under") || t.includes("minutes")) {
    if (t.includes("keep songs under")) {
      return { code: "too_long", message: text, detail: text, recovery: ["trim", "pick_another"] };
    }
  }

  if (t.includes("could not read that audio file") || t.includes("decode")) {
    return {
      code: "undecodable",
      message: "That file could not be decoded. It may be corrupt, or not really audio.",
      detail: text,
      recovery: ["pick_another", "compress"],
    };
  }

  if (t.includes("413") || t.includes("too large") || t.includes("entity too large")) {
    return { code: "too_big", message: "That file is larger than the 40 MB upload limit.", detail: text, recovery: ["compress", "trim"] };
  }

  if (t.includes("429") || t.includes("rate limit")) {
    return { code: "rate_limited", message: "The server is busy right now.", detail: text, recovery: ["wait", "retry"] };
  }

  if (t.includes("abort")) {
    return { code: "cancelled", message: "Cancelled.", recovery: ["retry"] };
  }

  if (t.includes("failed to fetch") || t.includes("networkerror") || t.includes("load failed")) {
    return {
      code: "network",
      message: "Could not reach the server. Check your connection and try again.",
      detail: text,
      recovery: ["retry"],
    };
  }

  return { code: "backend", message: text, detail: text, recovery: ["retry"] };
}
