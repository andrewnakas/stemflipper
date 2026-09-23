/**
 * A failure the visitor can do something about.
 *
 * Every JobError carries an ordered list of recovery actions, so the panel is the one
 * place that decides what a button offering "sign in" or "use Fast" actually does.
 */

import { useEffect, useState } from "preact/hooks";
import { AUDIOSAW, DEMO_FIXTURE } from "../../config";
import { login, isConfigured } from "../../api/hfAuth";
import type { JobError, Recovery } from "../../model/job";
import { openFixture, reset, retry, setPreset } from "../../model/jobStore";
import { formatWait } from "../../model/quota";
import { Button } from "../components/primitives";
import { Disclosure } from "../components/Disclosure";
import { Notice } from "../components/Notice";
import { wantToken } from "./AdvancedPanel";
import { navigate } from "../router";

const TITLES: Partial<Record<JobError["code"], string>> = {
  quota: "You are out of free GPU time for today",
  quota_runs: "You are out of free runs for today",
  rate_limited: "The server is busy",
  too_long: "That song is too long",
  too_big: "That file is too big",
  bad_format: "That file will not work",
  undecodable: "That file could not be read",
  sleeping: "The server is not available",
  network: "Lost the connection",
  cancelled: "Cancelled",
  auth: "Sign-in was not accepted",
  backend: "Something went wrong",
};

export function ErrorPanel({ error }: { error: JobError }) {
  // The server tells us how long until the quota resets; count it down from the moment
  // this error appeared, and restart the clock if a different error replaces it.
  const [remaining, setRemaining] = useState(error.retryAfterS ?? 0);

  useEffect(() => {
    setRemaining(error.retryAfterS ?? 0);
    if (!error.retryAfterS) return;
    const target = Date.now() + error.retryAfterS * 1000;
    const id = setInterval(() => setRemaining(Math.max(0, Math.round((target - Date.now()) / 1000))), 1000);
    return () => clearInterval(id);
  }, [error]);

  return (
    <Notice
      tone={error.code === "cancelled" ? "info" : "error"}
      title={TITLES[error.code] || "Something went wrong"}
      actions={error.recovery.map((r) => (
        <RecoveryButton key={r} what={r} error={error} remaining={remaining} />
      ))}
    >
      <p>{error.message}</p>
      {error.code === "quota_runs" ? (
        <p style={{ marginTop: "var(--s2)" }}>
          The shared pool limits how many songs everyone can run per day, not just how much
          GPU time. Your own allowance resets 24 hours after your first run, and a Hugging
          Face token gives you one of your own straight away — a free account is enough.
        </p>
      ) : null}
      {error.code === "quota" && error.leftS != null && error.requestedS != null ? (
        <p style={{ marginTop: "var(--s2)" }}>
          This run needed {error.requestedS} seconds and you have {error.leftS} left.
          {remaining ? ` Your allowance resets in about ${formatWait(remaining)}.` : ""}
        </p>
      ) : null}
      {error.detail && error.detail !== error.message ? (
        <Disclosure summary={<span class="small dim">What the server said</span>}>
          <code class="xs" style={{ wordBreak: "break-word" }}>{error.detail}</code>
        </Disclosure>
      ) : null}
    </Notice>
  );
}

function RecoveryButton({ what, error, remaining }: { what: Recovery; error: JobError; remaining: number }) {
  switch (what) {
    case "sign_in":
      if (!isConfigured()) return null;
      return (
        <Button variant="primary" onClick={() => void login()}>
          Sign in for more GPU time
        </Button>
      );
    case "use_fast":
      return (
        <Button
          onClick={() => {
            setPreset("fast");
            retry();
          }}
        >
          Try again on Fast
        </Button>
      );
    case "wait":
      return remaining > 0 ? (
        <span class="small dim" style={{ alignSelf: "center" }}>
          or wait {formatWait(remaining)}
        </span>
      ) : null;
    case "retry":
      return <Button onClick={retry}>Try again</Button>;
    case "trim":
      return <Button href={AUDIOSAW.trim}>Trim it with AudioSaw</Button>;
    case "compress":
      return <Button href={AUDIOSAW.compress}>Compress it with AudioSaw</Button>;
    case "convert":
      return <Button href={AUDIOSAW.convert}>Convert it with AudioSaw</Button>;
    case "demo":
      return (
        <Button
          variant="ghost"
          onClick={() => {
            void openFixture(DEMO_FIXTURE);
          }}
        >
          Hear the example instead
        </Button>
      );
    case "pick_another":
      return (
        <Button
          variant="ghost"
          onClick={() => {
            reset();
            navigate("home");
          }}
        >
          Choose another file
        </Button>
      );
    case "paste_token":
      // The server itself says a token is the fix, so make the field reachable from here
      // rather than leaving it buried under a disclosure the visitor has no reason to open.
      return (
        <Button variant={isConfigured() ? "default" : "primary"} onClick={() => (wantToken.value = true)}>
          Use a Hugging Face token
        </Button>
      );
    default:
      void error;
      return null;
  }
}
