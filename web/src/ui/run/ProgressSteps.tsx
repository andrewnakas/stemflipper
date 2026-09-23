/**
 * What the server is doing, in the visitor's language.
 *
 * The bar is the server's own progress fraction, eased between checkpoints — separation
 * reports 8% and then says nothing for most of the job, and a bar frozen at 8% for a
 * minute reads as broken.
 */

import { STEPS, stepIndex, type JobPhase } from "../../model/job";
import { formatBytes } from "../../model/preflight";
import { ProgressBar } from "../components/primitives";

export function ProgressSteps({ phase }: { phase: JobPhase }) {
  const { headline, detail, value, activeStep } = describe(phase);

  return (
    <div>
      <div class="row" style={{ marginBottom: "var(--s2)" }}>
        <b>{headline}</b>
        <span class="spacer" />
        {value != null ? <span class="small dim tabular">{Math.round(value * 100)}%</span> : null}
      </div>
      <ProgressBar value={value} label={headline} />
      {detail ? (
        <p class="small dim" style={{ marginTop: "var(--s2)" }} aria-live="polite">
          {detail}
        </p>
      ) : null}

      {activeStep != null ? (
        <ol class="steps" style={{ listStyle: "none", padding: 0, margin: "var(--s4) 0 0" }}>
          {STEPS.map((s, i) => {
            const state = i < activeStep ? "done" : i === activeStep ? "active" : "todo";
            return (
              <li key={s.id} class={`step step--${state}`}>
                <span class="step__dot" aria-hidden="true">{state === "done" ? "✓" : ""}</span>
                {s.label}
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}

function describe(phase: JobPhase): {
  headline: string;
  detail: string;
  value: number | null;
  activeStep: number | null;
} {
  switch (phase.kind) {
    case "uploading":
      return {
        headline: "Uploading your song",
        detail: `${formatBytes(Math.round(phase.file.bytes * phase.pct))} of ${formatBytes(phase.file.bytes)}`,
        value: phase.pct,
        activeStep: null,
      };
    case "waking":
      return {
        headline: "Waking up the server",
        detail:
          "It sleeps when nobody has used it for a couple of days. This takes a minute or two, and only happens to the first person of the day.",
        value: null,
        activeStep: null,
      };
    case "queued":
      return {
        headline: "Waiting for a free slot",
        detail:
          phase.rank === 1
            ? "One song ahead of yours."
            : `${phase.rank} songs ahead of yours.`,
        value: null,
        activeStep: null,
      };
    case "running":
      return {
        headline: STEPS[stepIndex(phase.step)]?.label || "Working",
        detail: phase.desc,
        value: phase.shown,
        activeStep: stepIndex(phase.step),
      };
    case "loading":
      return {
        headline: "Loading it into your browser",
        detail: phase.total ? `${phase.loaded} of ${phase.total} files` : "Fetching stems and samples…",
        value: phase.total ? phase.loaded / phase.total : null,
        activeStep: STEPS.length,
      };
    default:
      return { headline: "Working", detail: "", value: null, activeStep: null };
  }
}
