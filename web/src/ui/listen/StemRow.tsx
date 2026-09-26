/** One separated part of the song: hear it, isolate it, see it, and blend its three lanes. */

import { useEffect, useRef, useState } from "preact/hooks";
import { applyMixerNow, seek } from "../../model/playback";
import { mixer, notesByTrack, playhead, project as projectSignal, updateMixer } from "../../model/store";
import type { Track } from "../../model/types";
import { PianoRoll } from "../PianoRoll";
import { Badge, Button } from "../components/primitives";
import { Disclosure } from "../components/Disclosure";
import { LaneMixer } from "./LaneMixer";
import { SampleGrid } from "./SampleGrid";
import { Waveform } from "./Waveform";

const ROLL_H = 96;

export function StemRow({ track, duration }: { track: Track; duration: number }) {
  const m = mixer.value!;
  const notes = notesByTrack.value[track.id] || [];
  const soloed = Object.values(m.solo).some(Boolean);
  const quiet = m.mute[track.id] || (soloed && !m.solo[track.id]);
  const grid = projectSignal.value?.grid ?? null;
  const lanes = m.lanes[track.id] || { original: 1, synth: 0, sampler: 0 };
  const blended = (lanes.synth ?? 0) > 0.01 || (lanes.sampler ?? 0) > 0.01;

  const set = (fn: (s: typeof m) => void) => {
    updateMixer(fn);
    applyMixerNow();
  };

  // The roll is laid out in seconds, so it needs to know how wide it actually is. Measured
  // rather than assumed, because this column is narrower on a phone than on a laptop.
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  return (
    <div class={"stemrow" + (quiet ? " stemrow--quiet" : "")}>
      <div class="stemrow__head">
        <span class="swatch" style={{ background: track.color }} />
        <b>{track.name}</b>
        {track.audio.silent ? (
          <Badge>silent</Badge>
        ) : notes.length ? (
          <Badge title={`transcribed with ${track.transcription.engine}`}>{notes.length} notes</Badge>
        ) : null}
        {track.sub_stems?.length ? <Badge>{track.sub_stems.length} kit pieces</Badge> : null}
        {blended ? <Badge tone="ok">blended</Badge> : null}
        <span class="spacer" />
        <Button
          size="sm"
          on={Boolean(m.solo[track.id])}
          onClick={() => set((s) => { s.solo[track.id] = !s.solo[track.id]; })}
          title="Hear only this"
        >
          Solo
        </Button>
        <Button
          size="sm"
          on={Boolean(m.mute[track.id])}
          onClick={() => set((s) => { s.mute[track.id] = !s.mute[track.id]; })}
          title="Silence this"
        >
          Mute
        </Button>
      </div>

      <div class="stemrow__wave">
        {track.audio.src && !track.audio.silent ? (
          <Waveform
            src={track.audio.src}
            color={track.color}
            duration={duration}
            playhead={playhead.value}
            onSeek={seek}
          />
        ) : (
          <div class="small dim" style={{ padding: "12px 0" }}>
            Nothing was found in this stem — which is the right answer for a song with no {track.name.toLowerCase()}.
          </div>
        )}
      </div>

      <div class="stemrow__fader">
        <input
          type="range"
          min={0}
          max={130}
          value={Math.round((m.volume[track.id] ?? 1) * 100)}
          aria-label={`${track.name} volume`}
          onInput={(e) => set((s) => { s.volume[track.id] = Number((e.target as HTMLInputElement).value) / 100; })}
        />
      </div>

      {/* Collapsed by default: this page is for listening, and a stranger checking that it
          worked should not have to walk past three faders and a piano roll to reach Download. */}
      <div class="stemrow__more" ref={wrap}>
        <Disclosure summary={<span class="small">Blend the synth and samples, and see the notes</span>}>
          <LaneMixer track={track} noteCount={notes.length} />

          {notes.length && width > 0 ? (
            <div class="stemrow__roll">
              <PianoRoll
                track={track}
                notes={notes}
                grid={grid}
                duration={duration}
                pxPerSecond={width / Math.max(1, duration)}
                scrollX={0}
                playhead={playhead.value}
                height={ROLL_H}
                onGestureStart={(g) => {
                  // View only here — a click moves the playhead. Editing is Studio's job.
                  if (g.kind === "seek" || g.kind === "move") seek(g.time);
                }}
              />
              <p class="xs dim">
                The whole song at once. Click to move the playhead; open Studio to edit the notes.
              </p>
            </div>
          ) : null}

          <div class="stemrow__pads">
            <div class="xs dim" style={{ marginBottom: "var(--s2)" }}>
              Samples cut from this song
            </div>
            <SampleGrid track={track} />
          </div>
        </Disclosure>
      </div>
    </div>
  );
}
