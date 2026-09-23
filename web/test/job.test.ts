import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  classifyError, reduce, stepFromDesc, STEP_BOUNDS, STEPS,
  type GradioMsg, type JobEvent, type JobPhase,
} from "../src/model/job";

const FRAMES = readFileSync(fileURLToPath(new URL("./fixtures/gradio_frames.jsonl", import.meta.url)), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as { at: number; msg: GradioMsg });

const FILE = { name: "mix.wav", bytes: 1411244, durationS: 16, type: "audio/wav" };

function run(events: JobEvent[], start: JobPhase = { kind: "idle" }): JobPhase[] {
  const seen: JobPhase[] = [];
  let phase = start;
  for (const ev of events) {
    phase = reduce(phase, ev, { expectedS: 30 });
    seen.push(phase);
  }
  return seen;
}

describe("job reducer, driven by frames recorded from the live Space", () => {
  const events: JobEvent[] = [
    { type: "pick", file: FILE },
    ...FRAMES.map((f): JobEvent => ({ type: "gradio", msg: f.msg, now: 1_000 + f.at })),
  ];

  it("walks picked → running and reaches the packaging step", () => {
    const phases = run(events);
    const kinds = [...new Set(phases.map((p) => p.kind))];
    expect(kinds).toContain("picked");
    expect(kinds).toContain("running");

    const steps = phases.flatMap((p) => (p.kind === "running" ? [p.step] : []));
    // The recorded fast run touches these; `load` only appears via process_starts.
    expect(steps).toContain("separate");
    expect(steps).toContain("analyze");
    expect(steps).toContain("transcribe");
    expect(steps).toContain("samples");
    expect(steps).toContain("package");
    // steps only ever move forward
    const order = steps.map((s) => STEPS.findIndex((x) => x.id === s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("never shows a bar that goes backwards", () => {
    const phases = run(events);
    let last = 0;
    for (const p of phases) {
      if (p.kind !== "running") continue;
      expect(p.shown).toBeGreaterThanOrEqual(last - 1e-9);
      expect(p.shown).toBeLessThanOrEqual(1);
      last = p.shown;
    }
  });

  it("ignores heartbeats and the server's fictional ETA", () => {
    // The recording has rank_eta 300 for a job that finished in 28 s, so nothing may read it.
    const estimation = FRAMES.find((f) => f.msg.msg === "estimation")!;
    expect(estimation.msg.rank_eta).toBeGreaterThan(200);
    expect(estimation.msg.rank).toBe(0);
    // rank 0 must NOT produce a "queued" screen.
    const after = reduce({ kind: "picked", file: FILE }, { type: "gradio", msg: estimation.msg, now: 0 }, { expectedS: 30 });
    expect(after.kind).toBe("picked");

    const heartbeat = FRAMES.find((f) => f.msg.msg === "heartbeat");
    expect(heartbeat).toBeTruthy();
    const before: JobPhase = { kind: "running", file: FILE, step: "samples", desc: "x", pct: 0.7, shown: 0.7, stepStartedAt: 0, startedAt: 0, expectedS: 30 };
    expect(reduce(before, { type: "gradio", msg: heartbeat!.msg, now: 1 }, { expectedS: 30 })).toBe(before);
  });

  it("shows a queue only when someone is actually ahead", () => {
    const phase = reduce(
      { kind: "picked", file: FILE },
      { type: "gradio", msg: { msg: "estimation", rank: 2, queue_size: 3, rank_eta: 300 }, now: 0 },
      { expectedS: 30 },
    );
    expect(phase).toMatchObject({ kind: "queued", rank: 2, queueSize: 3 });
  });

  it("advances a silent step on tick without passing the next one", () => {
    const start = reduce(
      { kind: "picked", file: FILE },
      { type: "gradio", msg: { msg: "progress", progress_data: [{ progress: 0.08, desc: "Separating stems (balanced) — the slow part" }] }, now: 0 },
      { expectedS: 60 },
    );
    expect(start).toMatchObject({ kind: "running", step: "separate", shown: 0.08 });
    let p = start;
    for (const now of [2000, 5000, 20_000, 120_000]) p = reduce(p, { type: "tick", now }, { expectedS: 60 });
    const [, sepEnd] = STEP_BOUNDS.separate;
    expect(p.kind === "running" && p.shown).toBeGreaterThan(0.2);
    expect(p.kind === "running" && p.shown).toBeLessThan(sepEnd);
  });

  it("maps every description the real pipeline emitted", () => {
    const descs = FRAMES.flatMap((f) => (f.msg.msg === "progress" ? [f.msg.progress_data![0].desc as string] : []));
    expect(descs.length).toBeGreaterThan(8);
    for (const d of descs) expect(STEPS.map((s) => s.id)).toContain(stepFromDesc(d));
    expect(stepFromDesc("Separating stems (fast) — the slow part")).toBe("separate");
    expect(stepFromDesc("Loading audio")).toBe("load");
    expect(stepFromDesc("Analyzing tempo, key & chords")).toBe("analyze");
    expect(stepFromDesc("Transcribed drums")).toBe("transcribe");
    expect(stepFromDesc("Analyzing & transcribing vocals")).toBe("transcribe");
    expect(stepFromDesc("Building drums samples")).toBe("samples");
    expect(stepFromDesc("Reconstructing bass effects")).toBe("samples");
    expect(stepFromDesc("Writing MIDI, manifest, DAW projects")).toBe("package");
    expect(stepFromDesc("Zipping bundle")).toBe("package");
    expect(stepFromDesc("Done")).toBe("package");
  });
});

describe("classifyError", () => {
  it("parses the ZeroGPU quota refusal in both field orders", () => {
    const a = classifyError("You have exceeded your GPU quota (59s left vs. 60s requested). Please retry in 0:00:56");
    expect(a.code).toBe("quota");
    expect(a.leftS).toBe(59);
    expect(a.requestedS).toBe(60);
    expect(a.retryAfterS).toBe(56);
    expect(a.recovery).toContain("sign_in");

    const b = classifyError("You have exceeded your GPU quota (60s requested vs. 42s left)");
    expect(b.code).toBe("quota");
    expect(b.leftS).toBe(42);
    expect(b.requestedS).toBe(60);
  });

  it("reads the sign-up variant's long retry timer", () => {
    const e = classifyError(
      "You have exceeded your GPU quota (59s left vs. 120s requested). Sign-up on Hugging Face to get more quotas or retry in 5:03:25",
    );
    expect(e.code).toBe("quota");
    expect(e.retryAfterS).toBe(5 * 3600 + 3 * 60 + 25);
  });

  it("does not offer sign-in to someone who already has PRO", () => {
    const e = classifyError("You have exceeded your Pro GPU quota (10s left vs. 90s requested)");
    expect(e.code).toBe("quota");
    expect(e.recovery).not.toContain("sign_in");
  });

  it("tells a runs limit apart from a time limit", () => {
    // Verbatim from a real upload: it counts JOBS, carries no seconds at all, and names
    // the one remedy that works. Offering a cheaper preset here would be useless advice —
    // a shorter job is still a job.
    const e = classifyError(
      "You have exceeded your ZeroGPU runs limit. Authenticate with a Hugging Face token for more quota - https://huggingface.co/settings/tokens",
    );
    expect(e.code).toBe("quota_runs");
    expect(e.recovery).toContain("paste_token");
    expect(e.recovery).toContain("sign_in");
    expect(e.recovery).not.toContain("use_fast");
    expect(e.message).toMatch(/runs/i);
    expect(e.message).not.toMatch(/GPU time/i);
    expect(e.leftS).toBeUndefined();
  });

  it("still treats a seconds-based refusal as one, and does offer a cheaper preset", () => {
    const e = classifyError("You have exceeded your GPU quota (59s left vs. 60s requested). Please retry in 0:00:56");
    expect(e.code).toBe("quota");
    expect(e.recovery).toContain("use_fast");
  });

  it("recognises a token that was rejected", () => {
    expect(classifyError("Falling back to IP-based quotas (InvalidRepoToken)").code).toBe("auth");
  });

  it("explains an expired ZeroGPU proxy token as retryable", () => {
    // Hit for real while building the demo fixture: a 172 s upload outlived the token.
    const e = classifyError("Expired ZeroGPU proxy token");
    expect(e.code).toBe("backend");
    expect(e.recovery).toContain("retry");
    expect(e.message).toMatch(/again/i);
  });

  it("maps app.py's own refusals", () => {
    expect(classifyError("That file is 9.4 minutes; please keep songs under 8 minutes for this demo.").code).toBe("too_long");
    expect(classifyError("Could not read that audio file. Error opening …").code).toBe("undecodable");
    expect(classifyError("upload failed (413)").code).toBe("too_big");
    expect(classifyError("queue join failed (429)").code).toBe("rate_limited");
  });

  it("always produces something actionable", () => {
    for (const t of ["boom", "", "TypeError: x is not a function"]) {
      const e = classifyError(t);
      expect(e.recovery.length).toBeGreaterThan(0);
      expect(typeof e.message).toBe("string");
    }
  });
});
