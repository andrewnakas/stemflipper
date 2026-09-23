/** One separated part of the song: hear it, isolate it, see it. */

import { applyMixerNow, seek } from "../../model/playback";
import { mixer, notesByTrack, playhead, updateMixer } from "../../model/store";
import type { Track } from "../../model/types";
import { Badge, Button } from "../components/primitives";
import { Waveform } from "./Waveform";

export function StemRow({ track, duration }: { track: Track; duration: number }) {
  const m = mixer.value!;
  const notes = notesByTrack.value[track.id] || [];
  const soloed = Object.values(m.solo).some(Boolean);
  const quiet = m.mute[track.id] || (soloed && !m.solo[track.id]);

  const set = (fn: (s: typeof m) => void) => {
    updateMixer(fn);
    applyMixerNow();
  };

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
    </div>
  );
}
