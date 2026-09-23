/**
 * The editor. Behaviour is v2's, moved here and re-skinned: three lanes per track, a
 * piano roll you can edit, and the stage trail. What is new is that it is a destination
 * you choose from Listen rather than the first thing a visitor sees.
 */

import { useEffect, useState } from "preact/hooks";
import { applyMixerNow, seek } from "../../model/playback";
import {
  loopRegion, mixer, notesByTrack, playhead, project, pxPerSecond, scrollX,
  selectedTrack, selection, tool, updateMixer,
} from "../../model/store";
import type { LaneId, Track } from "../../model/types";
import { levels } from "../../model/playback";
import { PianoRoll } from "../PianoRoll";
import { Ruler } from "../Ruler";
import { navigate } from "../router";
import { setStudioScheme } from "../theme";
import { endGesture, marquee, moveGesture, startGesture } from "./gestures";
import { installKeymap } from "./keymap";
import { LaneExplainer } from "./LaneExplainer";
import { ExportDialog } from "./ExportDialog";
import { ShortcutSheet } from "./ShortcutSheet";
import { StudioBar } from "./StudioBar";

const SEEN_KEY = "sf.studio.seen";

const LANES: { id: LaneId; label: string; hint: string }[] = [
  { id: "original", label: "Original", hint: "the separated stem itself" },
  { id: "synth", label: "Synth", hint: "the transcription played on a synth" },
  { id: "sampler", label: "Sampler", hint: "the transcription played on samples cut from this song" },
];

export function Studio() {
  const [help, setHelp] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    setStudioScheme(true);
    const removeKeys = installKeymap(() => setHelp(true));
    let firstRun = false;
    try {
      firstRun = !localStorage.getItem(SEEN_KEY);
      if (firstRun) localStorage.setItem(SEEN_KEY, "1");
    } catch {
      /* private window: just skip the tour */
    }
    if (firstRun) setHelp(true);
    return () => {
      setStudioScheme(false);
      removeKeys();
    };
  }, []);

  const p = project.value;
  if (!p) {
    navigate("home", { replace: true });
    return null;
  }

  const setLoop = (a: number, b: number) => {
    const lo = Math.max(0, Math.min(a, b));
    const hi = Math.min(p.song.duration, Math.max(a, b));
    loopRegion.value = { a: lo, b: hi, on: hi - lo > 0.05 };
  };

  return (
    <div class="studio" style={{ display: "contents" }}>
      <StudioBar onHelp={() => setHelp(true)} onExport={() => setExporting(true)} />
      <LaneExplainer />
      <div class="studio-narrow">Studio works best on a larger screen — the piano roll needs room.</div>
      <div
        class="studio-scroll"
        onScroll={(e) => (scrollX.value = (e.target as HTMLDivElement).scrollLeft)}
      >
        <div style={{ display: "flex" }}>
          <div style={{ width: "260px", minWidth: "260px" }} />
          <div style={{ flex: 1 }}>
            <Ruler
              grid={p.grid}
              duration={p.song.duration}
              pxPerSecond={pxPerSecond.value}
              scrollX={scrollX.value}
              playhead={playhead.value}
              loop={loopRegion.value}
              sections={p.sections}
              onSeek={seek}
              onLoop={setLoop}
            />
          </div>
        </div>
        <div class="tracks">
          {p.tracks.map((t) => (
            <TrackRow key={t.id} track={t} level={levels.value[t.id] || 0} />
          ))}
        </div>
        <StageTrail />
      </div>
      {help ? <ShortcutSheet onClose={() => setHelp(false)} /> : null}
      {exporting ? <ExportDialog onClose={() => setExporting(false)} /> : null}
    </div>
  );
}

function TrackRow({ track, level }: { track: Track; level: number }) {
  const m = mixer.value!;
  const notes = notesByTrack.value[track.id] || [];
  const hasNotes = notes.length > 0;
  const mq = marquee.value;

  const set = (fn: (s: typeof m) => void) => {
    updateMixer(fn);
    applyMixerNow();
  };

  return (
    <div class="track">
      <div class="trackhead">
        <div class="row">
          <span class="track__name">
            <span class="swatch" style={{ background: track.color }} />
            {track.name}
          </span>
          <span class="spacer" />
          <span class="xs dim">{track.audio.silent ? "silent" : `${notes.length} notes`}</span>
        </div>
        <div class="xs dim">
          {track.audio.silent ? "no signal in this stem" : track.transcription.engine}
          {track.sub_stems.length ? ` · ${track.sub_stems.length} kit pieces` : ""}
        </div>

        {LANES.map((lane) => (
          <div class="lanefader" key={lane.id} title={lane.hint}>
            <span>{lane.label}</span>
            <input
              type="range"
              min="0"
              max="100"
              value={Math.round((m.lanes[track.id]?.[lane.id] ?? 0) * 100)}
              disabled={lane.id !== "original" && !hasNotes}
              aria-label={`${track.name} ${lane.label}`}
              onInput={(e) => set((s) => { s.lanes[track.id][lane.id] = Number((e.target as HTMLInputElement).value) / 100; })}
            />
            <span class="dim">{Math.round((m.lanes[track.id]?.[lane.id] ?? 0) * 100)}</span>
          </div>
        ))}

        <div class="lanefader" title="stereo position">
          <span>Pan</span>
          <input
            type="range" min="-100" max="100"
            value={Math.round((m.pan[track.id] ?? 0) * 100)}
            aria-label={`${track.name} pan`}
            onInput={(e) => set((s) => { s.pan[track.id] = Number((e.target as HTMLInputElement).value) / 100; })}
          />
          <span class="dim">{panLabel(m.pan[track.id] ?? 0)}</span>
        </div>
        <div class="lanefader" title="track volume">
          <span>Volume</span>
          <input
            type="range" min="0" max="130"
            value={Math.round((m.volume[track.id] ?? 1) * 100)}
            aria-label={`${track.name} volume`}
            onInput={(e) => set((s) => { s.volume[track.id] = Number((e.target as HTMLInputElement).value) / 100; })}
          />
          <span class="dim">{Math.round((m.volume[track.id] ?? 1) * 100)}</span>
        </div>

        <div class="row">
          <button
            class={"btn btn--sm" + (m.solo[track.id] ? " btn--on" : "")}
            onClick={() => set((s) => { s.solo[track.id] = !s.solo[track.id]; })}
          >
            Solo
          </button>
          <button
            class={"btn btn--sm" + (m.mute[track.id] ? " btn--on" : "")}
            onClick={() => set((s) => { s.mute[track.id] = !s.mute[track.id]; })}
          >
            Mute
          </button>
          {track.effects?.eq?.bands?.length ? (
            <button
              class={"btn btn--sm" + (m.fx[track.id] ? " btn--on" : "")}
              title="Apply the EQ curve and reverb measured from this stem"
              onClick={() => set((s) => { s.fx[track.id] = !s.fx[track.id]; })}
            >
              FX
            </button>
          ) : null}
          <span class="spacer" />
          <div class="meter" title="output level">
            <div class="meter__fill" style={{ height: `${Math.min(100, level * 130)}%` }} />
          </div>
        </div>
      </div>
      <div class="tracklanes">
        {hasNotes || track.kind !== "drums" ? (
          <PianoRoll
            track={track}
            notes={notes}
            grid={project.value!.grid}
            duration={project.value!.song.duration}
            pxPerSecond={pxPerSecond.value}
            scrollX={scrollX.value}
            playhead={playhead.value}
            selection={selectedTrack.value === track.id ? selection.value : undefined}
            marquee={mq?.track === track.id ? mq.rect : null}
            tool={tool.value}
            onGestureStart={(g) => startGesture(track.id, notes, g)}
            onGestureMove={(t, pitch) => moveGesture(track.id, t, pitch)}
            onGestureEnd={endGesture}
          />
        ) : (
          <div class="small dim" style={{ padding: "18px 12px" }}>
            no transcription for this stem — the Original lane still plays
          </div>
        )}
      </div>
    </div>
  );
}

function StageTrail() {
  const p = project.value!;
  const notable = p.stages.filter((s) => s.status !== "ok");
  return (
    <div class="card" style={{ margin: "var(--s3)" }}>
      <div class="row">
        <b>How this was made</b>
        <span class="spacer" />
        <span class="xs dim">
          preset {p.separation.preset} · {p.separation.gpu_seconds.toFixed(1)}s on {p.separation.device}
        </span>
      </div>
      <div class="scroll-x" style={{ marginTop: "var(--s2)" }}>
      <table class="facts">
        <tbody>
          {p.separation.chain.map((c) => (
            <tr key={c.step}>
              <td>{c.step}</td>
              <td class="dim xs">{c.model}</td>
              <td class="dim xs">{c.seconds}s</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {notable.length > 0 && (
        <ul class="small" style={{ paddingLeft: "1.1em" }}>
          {notable.map((s) => (
            <li key={s.name}>
              <span class={`stage-${s.status}`}>{s.name}: {s.status}</span> — {s.detail}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function panLabel(p: number): string {
  if (Math.abs(p) < 0.02) return "C";
  return `${p < 0 ? "L" : "R"}${Math.round(Math.abs(p) * 100)}`;
}
