/** Play, scrub, and where you are. Sticky, because it is the control you keep reaching for. */

import { formatTime } from "../../model/grid";
import { playhead, playing } from "../../model/store";
import { seek, togglePlay } from "../../model/playback";
import { Button } from "../components/primitives";

export function TransportBar({ duration }: { duration: number }) {
  const t = playhead.value;
  return (
    <div class="transport">
      <Button variant="primary" onClick={() => void togglePlay()} aria-label={playing.value ? "Pause" : "Play"}>
        {playing.value ? "❚❚" : "▶"}
      </Button>
      <span class="transport__clock tabular">{formatTime(t)}</span>
      <input
        class="transport__scrub"
        type="range"
        min={0}
        max={Math.max(0.1, duration)}
        step={0.01}
        value={t}
        aria-label="Position in the song"
        onInput={(e) => seek(Number((e.target as HTMLInputElement).value))}
      />
      <span class="transport__clock tabular dim">{formatTime(duration)}</span>
    </div>
  );
}
