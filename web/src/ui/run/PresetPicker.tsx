/**
 * Quality vs. how much of the day's GPU time it costs.
 *
 * The estimate is real: the Space asks ZeroGPU for exactly this many seconds, and ZeroGPU
 * refuses the job outright if that is more than the caller has left. A preset that cannot
 * possibly run is disabled with the reason rather than offered and then rejected.
 */

import { PRESETS } from "../../config";
import { tier } from "../../model/auth";
import type { FileMeta } from "../../model/job";
import { options, setPreset, setSix } from "../../model/jobStore";
import { dailyBudgetS, estimateGpuSeconds, fitsBudget, formatSeconds, PRESET_INFO, songsPerDay } from "../../model/quota";
import { Disclosure } from "../components/Disclosure";
import { Segmented } from "../components/Segmented";

export function PresetPicker({ file }: { file: FileMeta }) {
  const { preset, six } = options.value;
  const duration = file.durationS ?? 210;
  const you = tier();
  const seconds = estimateGpuSeconds(duration, preset, six);

  return (
    <>
      <p class="small">
        <b>{PRESET_INFO[preset].label}</b> — {PRESET_INFO[preset].blurb}{" "}
        <span class="dim">
          About {formatSeconds(seconds)} of GPU, out of {formatSeconds(dailyBudgetS(you))} a day.
        </span>
      </p>

      <Disclosure summary={<span class="small">Change quality</span>}>
        <Segmented
          label="Separation quality"
          value={preset}
          onChange={(p) => setPreset(p)}
          options={PRESETS.map((p) => ({
            value: p,
            label: `${PRESET_INFO[p].label} · ${formatSeconds(estimateGpuSeconds(duration, p, six))}`,
            disabled: !fitsBudget(you, p, duration, six),
            title: fitsBudget(you, p, duration, six)
              ? PRESET_INFO[p].blurb
              : `Needs more GPU time than a full day's allowance (${formatSeconds(dailyBudgetS(you))}).`,
          }))}
        />
        <ul class="small dim" style={{ marginTop: "var(--s3)", paddingLeft: "1.1em" }}>
          {PRESETS.map((p) => (
            <li key={p}>
              <b>{PRESET_INFO[p].label}:</b> {PRESET_INFO[p].blurb}{" "}
              {fitsBudget(you, p, duration, six)
                ? `Up to ${songsPerDay(you, p, duration, six)} song${songsPerDay(you, p, duration, six) === 1 ? "" : "s"} a day.`
                : "Too long for one day's allowance."}
            </li>
          ))}
        </ul>
        <label class="small row" style={{ marginTop: "var(--s3)" }}>
          <input type="checkbox" checked={six} onChange={(e) => setSix((e.target as HTMLInputElement).checked)} />
          Also try to split guitar and piano out of the "other" stem
          <span class="dim">— experimental, and piano tends to bleed</span>
        </label>
      </Disclosure>
    </>
  );
}
