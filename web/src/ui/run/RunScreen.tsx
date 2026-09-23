/** Everything between choosing a file and having a result. */

import { LIMITS } from "../../config";
import { job, cancelJob, reset, startPending } from "../../model/jobStore";
import { formatBytes, formatDuration } from "../../model/preflight";
import { Button, Card } from "../components/primitives";
import { navigate } from "../router";
import { AdvancedPanel } from "./AdvancedPanel";
import { ErrorPanel } from "./ErrorPanel";
import { PresetPicker } from "./PresetPicker";
import { ProgressSteps } from "./ProgressSteps";
import { QuotaNote } from "../account/QuotaNote";

export function RunScreen() {
  const phase = job.value;

  if (phase.kind === "idle") {
    navigate("home", { replace: true });
    return null;
  }

  const working = ["uploading", "waking", "queued", "running", "loading"].includes(phase.kind);

  return (
    <div class="screen screen--scroll">
      <div class="container container--narrow" style={{ paddingTop: "var(--s6)", paddingBottom: "var(--s7)" }}>
        {"file" in phase && phase.file?.name ? (
          <Card class="stack" style={{ gap: "var(--s3)" }}>
            <div class="row wrap">
              <div class="stack">
                <b>{phase.file.name}</b>
                <span class="small dim">
                  {formatDuration(phase.file.durationS)} · {formatBytes(phase.file.bytes)}
                </span>
              </div>
              <span class="spacer" />
              {phase.kind === "picked" ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    reset();
                    navigate("home");
                  }}
                >
                  Change
                </Button>
              ) : null}
            </div>

            {phase.kind === "picked" ? (
              <>
                <PresetPicker file={phase.file} />
                <QuotaNote file={phase.file} />
                <Button
                  variant="primary"
                  size="lg"
                  block
                  onClick={startPending}
                >
                  Flip it
                </Button>
                <AdvancedPanel />
              </>
            ) : null}

            {working ? (
              <>
                <ProgressSteps phase={phase} />
                <div class="row" style={{ marginTop: "var(--s3)" }}>
                  <span class="xs dim">Keep this tab open.</span>
                  <span class="spacer" />
                  <Button size="sm" variant="ghost" onClick={cancelJob}>
                    Cancel
                  </Button>
                </div>
              </>
            ) : null}
          </Card>
        ) : null}

        {phase.kind === "error" ? (
          <div class="stack" style={{ marginTop: "var(--s4)", gap: "var(--s3)" }}>
            <ErrorPanel error={phase.error} />
            {/* The token field has to be reachable from the failure that recommends it. */}
            {["quota", "quota_runs", "auth"].includes(phase.error.code) ? (
              <div class="card">
                <AdvancedPanel />
              </div>
            ) : null}
          </div>
        ) : null}

        {phase.kind === "picked" ? (
          <p class="xs dim center" style={{ marginTop: "var(--s4)" }}>
            Your song is uploaded to a Hugging Face Space, processed there, and deleted within 6
            hours. Up to {LIMITS.maxMinutes} minutes and {LIMITS.maxBytesLabel} per file.
          </p>
        ) : null}
      </div>
    </div>
  );
}
