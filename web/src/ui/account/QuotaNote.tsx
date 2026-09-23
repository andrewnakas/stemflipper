/** One line telling the visitor what this run costs them, and what signing in would change. */

import { isConfigured, login } from "../../api/hfAuth";
import { auth, tier } from "../../model/auth";
import type { FileMeta } from "../../model/job";
import { options } from "../../model/jobStore";
import { dailyBudgetS, estimateGpuSeconds, formatSeconds, songsPerDay } from "../../model/quota";
import { Button } from "../components/primitives";

export function QuotaNote({ file }: { file: FileMeta }) {
  const { preset, six } = options.value;
  const duration = file.durationS ?? 210;
  const you = tier();
  const cost = estimateGpuSeconds(duration, preset, six);
  const perDay = songsPerDay(you, preset, duration, six);

  if (auth.value.status !== "anonymous") {
    return (
      <p class="xs dim">
        About {formatSeconds(cost)} of your {formatSeconds(dailyBudgetS(you))} daily GPU time —
        roughly {perDay} song{perDay === 1 ? "" : "s"} like this a day.
      </p>
    );
  }

  return (
    <p class="xs dim">
      About {formatSeconds(cost)} of the shared {formatSeconds(dailyBudgetS("anonymous"))} that
      everyone without an account gets each day.
      {isConfigured() ? (
        <>
          {" "}
          <Button
            size="sm"
            variant="ghost"
            style={{ minHeight: "auto", padding: "0 2px", textDecoration: "underline" }}
            onClick={() => void login()}
          >
            Sign in
          </Button>{" "}
          for {formatSeconds(dailyBudgetS("free"))} of your own.
        </>
      ) : null}
    </p>
  );
}
