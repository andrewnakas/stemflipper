/**
 * Where the work happens, and which engine does it.
 *
 * The shared GPU pool is two minutes a day across everyone who is not signed in, plus a
 * limit on the number of runs — so for most visitors the server is simply not available.
 * Running in the browser has no limit and uploads nothing.
 *
 * The browser card now has a choice inside it, because the engines are genuinely different
 * trades rather than a quality dial: four stems fast, two stems with a cleaner vocal, or the
 * server's own model at minutes per minute of audio. Each one states its own pros and cons
 * and its own estimate for THIS song, so nobody discovers the cost after committing.
 */

import { useEffect, useState } from "preact/hooks";
import { auth, tier } from "../../model/auth";
import type { FileMeta } from "../../model/job";
import { options, setEngine, setWhere, type RunWhere } from "../../model/jobStore";
import { estimateGpuSeconds, formatSeconds } from "../../model/quota";
import { formatEstimate, localCapability, localEstimateSeconds } from "../../local/capability";
import { ENGINE_IDS, engineSpec, isEngineCached, type LocalEngine } from "../../local/engines";
import { Badge } from "../components/primitives";

export function WherePicker({ file }: { file: FileMeta }) {
  const cap = localCapability();
  const where = options.value.where;
  const engine = options.value.engine;
  const duration = file.durationS ?? 210;
  const spec = engineSpec(engine);
  const local = localEstimateSeconds(duration, cap, engine);
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
        badge={<Badge tone="ok">no limits</Badge>}
        time={formatEstimate(local)}
        lines={[
          `${spec.stems.length} stems — ${spec.summary} Each one transcribed to MIDI.`,
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
      {where === "browser" && cap.speed !== "unsupported" ? (
        <div class="engines">
          <span class="xs dim">Which split?</span>
          {ENGINE_IDS.map((id) => (
            <EngineOption
              key={id}
              id={id}
              on={id === engine}
              seconds={localEstimateSeconds(duration, cap, id)}
              onPick={() => setEngine(id)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** One engine, with what it is good and bad at spelled out rather than implied. */
function EngineOption(props: { id: LocalEngine; on: boolean; seconds: number; onPick: () => void }) {
  const spec = engineSpec(props.id);
  // The download is once per device but not quick, so say which it is. Without this the
  // estimate is a promise the first visit cannot keep.
  const [cached, setCached] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void isEngineCached(props.id).then((c) => live && setCached(c));
    return () => {
      live = false;
    };
  }, [props.id]);
  return (
    <button
      type="button"
      class={"engine" + (props.on ? " engine--on" : "")}
      aria-pressed={props.on}
      onClick={props.onPick}
    >
      <span class="engine__head">
        <b>{spec.label}</b>
        <span class="spacer" />
        <span class="xs dim nowrap">
          {formatEstimate(props.seconds)} ·{" "}
          {cached === true ? "already downloaded" : `${spec.downloadMb} MB to fetch first`}
        </span>
      </span>
      <span class="engine__why">
        {spec.pros.map((t) => (
          <span class="xs engine__pro" key={t}>
            + {t}
          </span>
        ))}
        {spec.cons.map((t) => (
          <span class="xs engine__con" key={t}>
            − {t}
          </span>
        ))}
      </span>
    </button>
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
