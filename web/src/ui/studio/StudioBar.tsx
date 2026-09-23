/** The editor toolbar: transport, tools, snap, undo, export. */

import { barsBeats, formatTime } from "../../model/grid";
import { togglePlay, toggleLoop } from "../../model/playback";
import {
  busy, canRedo, canUndo, edited, historyDepth, loopRegion, playhead, playing,
  project, pxPerSecond, redo, snapDivision, tool, undo,
} from "../../model/store";
import { Button } from "../components/primitives";
import { navigate } from "../router";
import { downloadMix } from "../exports";

const TOOLS = [
  { id: "select", glyph: "⌖", label: "Select (V)" },
  { id: "draw", glyph: "✎", label: "Draw (D)" },
  { id: "erase", glyph: "⌫", label: "Erase (E)" },
] as const;

export function StudioBar({ onHelp, onExport }: { onHelp: () => void; onExport: () => void }) {
  const p = project.value;
  if (!p) return null;

  return (
    <div class="studiobar">
      <Button size="sm" variant="ghost" onClick={() => navigate("listen")}>
        ← Listen
      </Button>
      <Button variant="primary" size="sm" onClick={() => void togglePlay()}>
        {playing.value ? "❚❚" : "▶"}
      </Button>
      <span class="studiobar__clock">{barsBeats(p.grid, playhead.value)}</span>
      <span class="dim xs nowrap">
        {formatTime(playhead.value)} / {formatTime(p.song.duration)} · {Math.round(p.grid.tempo)} BPM ·{" "}
        {p.grid.time_signature} · {p.key.name}
      </span>

      <Button size="sm" on={loopRegion.value.on} onClick={toggleLoop} title="Loop the selected region (L)">
        ⟲
      </Button>
      <Button size="sm" onClick={() => (pxPerSecond.value = Math.max(4, pxPerSecond.value / 1.3))} title="Zoom out (−)">−</Button>
      <Button size="sm" onClick={() => (pxPerSecond.value = Math.min(400, pxPerSecond.value * 1.3))} title="Zoom in (+)">+</Button>

      <span class="studiobar__sep">|</span>
      {TOOLS.map((t) => (
        <Button key={t.id} size="sm" on={tool.value === t.id} title={t.label} onClick={() => (tool.value = t.id)}>
          {t.glyph}
        </Button>
      ))}
      <label class="xs dim row" title="Snap edits to this subdivision">
        snap{" "}
        <select
          value={String(snapDivision.value)}
          onChange={(e) => (snapDivision.value = Number((e.target as HTMLSelectElement).value))}
        >
          <option value="1">1/4</option>
          <option value="2">1/8</option>
          <option value="4">1/16</option>
          <option value="8">1/32</option>
          <option value="0">off</option>
        </select>
      </label>
      <Button size="sm" onClick={() => undo()} disabled={!canUndo()} title="Undo (Cmd/Ctrl-Z)">↶</Button>
      <Button size="sm" onClick={() => redo()} disabled={!canRedo()} title="Redo (Cmd/Ctrl-Shift-Z)">↷</Button>
      {edited.value ? (
        <span class="xs" style={{ color: "var(--accent)" }}>
          {historyDepth.value} edit{historyDepth.value === 1 ? "" : "s"}
        </span>
      ) : null}

      <span class="spacer" />
      <Button size="sm" onClick={() => void downloadMix()} disabled={busy.value}>⬇ Mix</Button>
      <Button size="sm" onClick={onExport} disabled={busy.value} title="Choose what to export">
        ⬇ Export…
      </Button>
      <Button size="sm" variant="ghost" onClick={onHelp} title="Keyboard shortcuts (?)">?</Button>
    </div>
  );
}
