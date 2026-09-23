/**
 * Where the work happens.
 *
 * The shared GPU pool is two minutes a day across everyone who is not signed in, plus a
 * limit on the number of runs — so for most visitors the server is simply not available.
 * Running in the browser has no limit at all and uploads nothing; it just cannot do the
 * four-stem split or build samples, and it is only fast where the browser can reach a GPU.
 * Both of those are stated up front rather than discovered.
 */

import { auth, tier } from "../../model/auth";
import type { FileMeta } from "../../model/job";
import { options, setWhere, type RunWhere } from "../../model/jobStore";
import { estimateGpuSeconds, formatSeconds } from "../../model/quota";
import { formatEstimate, localCapability, localEstimateSeconds } from "../../local/capability";
import { Badge } from "../components/primitives";

export function WherePicker({ file }: { file: FileMeta }) {
  const cap = localCapability();
  const where = options.value.where;
  const duration = file.durationS ?? 210;
  const local = localEstimateSeconds(duration, cap);
  const gpu = estimateGpuSeconds(duration, options.value.preset, options.value.six);
  const anonymous = auth.value.status === "anonymous";

  const choose = (w: RunWhere) => setWhere(w);

  return (
    <div class="where">
      <Choice
        id="browser"
        on={where === "browser"}
        disabled={cap.speed === "unsupported"}
        onPick={() => choose("browser")}
        title="In your browser"
        badge={cap.speed === "gpu" ? <Badge tone="ok">no limits</Badge> : null}
        time={formatEstimate(local)}
        lines={[
          "Vocals and instrumental, each transcribed to MIDI.",
          "Nothing is uploaded, and there is no daily limit.",
          cap.why,
        ]}
      />
      <Choice
        id="server"
        on={where === "server"}
        onPick={() => choose("server")}
        title="On the server"
        badge={anonymous ? <Badge tone="warn">shared quota</Badge> : null}
        time={`${formatSeconds(gpu)} of GPU`}
        lines={[
          "Four stems, the drum kit split into its pieces, plus samples, instruments and loops.",
          "Your song is uploaded, processed and deleted within 6 hours.",
          anonymous
            ? "Uses the pool everyone without an account shares — two minutes a day between all of them."
            : `Uses your own daily allowance (${formatSeconds(tier() === "pro" ? 2400 : 300)}).`,
        ]}
      />
    </div>
  );
}

function Choice(props: {
  id: string;
  on: boolean;
  disabled?: boolean;
  onPick: () => void;
  title: string;
  badge: preact.ComponentChildren;
  time: string;
  lines: string[];
}) {
  return (
    <button
      type="button"
      class={"where__opt" + (props.on ? " where__opt--on" : "")}
      aria-pressed={props.on}
      disabled={props.disabled}
      onClick={props.onPick}
    >
      <span class="where__head">
        <b>{props.title}</b>
        {props.badge}
        <span class="spacer" />
        <span class="xs dim nowrap">{props.time}</span>
      </span>
      <span class="where__lines">
        {props.lines.filter(Boolean).map((l) => (
          <span class="xs" key={l}>
            {l}
          </span>
        ))}
      </span>
    </button>
  );
}
