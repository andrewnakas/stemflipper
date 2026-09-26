/**
 * The three lanes of one track, as faders you can actually reach.
 *
 * Every track carries the separated stem, the same part played by a synth, and the same part
 * played on samples cut from this song. Until now blending them meant opening Studio, which is
 * a piano-roll editor — a lot of screen to cross for what is really a three-fader question. The
 * faders live on Listen now, behind a disclosure so the default view stays a listening page.
 *
 * A lane with nothing in it is shown disabled with the reason, rather than as a dead fader: the
 * synth needs notes, and the sampler needs an instrument, which only the server builds.
 */

import { applyMixerNow } from "../../model/playback";
import { mixer, updateMixer } from "../../model/store";
import type { LaneId, Track } from "../../model/types";

const LANES: { id: LaneId; label: string; hint: string }[] = [
  { id: "original", label: "Stem", hint: "The separated audio itself." },
  { id: "synth", label: "Synth", hint: "The transcribed notes on a synth." },
  { id: "sampler", label: "Samples", hint: "The transcribed notes on samples cut from this song." },
];

export function LaneMixer({ track, noteCount }: { track: Track; noteCount: number }) {
  const m = mixer.value!;
  const lanes = m.lanes[track.id] || { original: 1, synth: 0, sampler: 0 };

  const why = (id: LaneId): string | null => {
    if (id === "original") return track.audio.silent ? "This stem is silent." : null;
    if (!noteCount) return "Nothing was transcribed in this part.";
    if (id === "sampler" && !track.instrument.sampler) {
      return "Samples are built on the server — a run in your browser does not make them.";
    }
    return null;
  };

  const set = (id: LaneId, value: number) => {
    updateMixer((s) => {
      if (s.lanes[track.id]) s.lanes[track.id][id] = value;
    });
    applyMixerNow();
  };

  return (
    <div class="lanemix">
      {LANES.map((lane) => {
        const blocked = why(lane.id);
        const value = lanes[lane.id] ?? 0;
        return (
          <div class={"lanemix__row" + (blocked ? " lanemix__row--off" : "")} key={lane.id}>
            <button
              type="button"
              class="lanemix__name"
              disabled={!!blocked}
              title={blocked || `${lane.hint} Click to ${value > 0.01 ? "mute" : "bring in"}.`}
              onClick={() => set(lane.id, value > 0.01 ? 0 : 1)}
            >
              {lane.label}
            </button>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(value * 100)}
              disabled={!!blocked}
              aria-label={`${track.name} ${lane.label} level`}
              title={blocked || lane.hint}
              onInput={(e) => set(lane.id, Number((e.target as HTMLInputElement).value) / 100)}
            />
            <span class="xs dim lanemix__value">
              {blocked ? "—" : `${Math.round(value * 100)}%`}
            </span>
          </div>
        );
      })}
      <p class="xs dim lanemix__note">
        {LANES.every((l) => why(l.id))
          ? "Nothing to blend on this track."
          : "Bring the synth or the samples up against the stem to hear how close the transcription got."}
      </p>
    </div>
  );
}
