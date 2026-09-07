/** The StemFlipper editor: upload, then mix the original stems against the reconstruction. */

import { useEffect, useRef, useState } from "preact/hooks";
import { runFlip, uploadFile } from "../api/backend";
import { audioContext, resumeAudio } from "../engine/context";
import { bufferRms, renderMix } from "../engine/render";
import { Session } from "../engine/session";
import { encodeWav } from "../export/wav";
import { barsBeats, formatTime } from "../model/grid";
import {
  assetSource, backend, busy, canRedo, canUndo, commitEdit, duration, edited,
  historyDepth, loadProject, loopRegion, mixer, notesByTrack, playhead, playing,
  previewEdit, project, pxPerSecond, redo, saveBackend, scrollX, selectedTrack, selection,
  setNotesListener, snapDivision, status, tool, undo, updateMixer,
} from "../model/store";
import type { LaneId, Note, Project, Track } from "../model/types";
import { buildExportZip } from "../export/bundle";
import {
  addNote, deleteNotes, moveNotes, notesIn, quantizeNotes, resizeNotes, setVelocity,
  type Change,
} from "../model/notes";
import { PianoRoll, type RollGesture } from "./PianoRoll";
import { Ruler } from "./Ruler";

const LANES: { id: LaneId; label: string; hint: string }[] = [
  { id: "original", label: "Original", hint: "the separated stem itself" },
  { id: "synth", label: "Synth", hint: "the transcription played on a synth" },
  { id: "sampler", label: "Sampler", hint: "the transcription played on samples cut from this song" },
];

let session: Session | null = null;

export function App() {
  const [levels, setLevels] = useState<Record<string, number>>({});
  const raf = useRef(0);

  useEffect(() => {
    const loop = () => {
      if (session) {
        playhead.value = session.transport.now();
        playing.value = session.transport.playing;
        if (session.transport.playing) setLevels(session.levels());
      }
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf.current);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (!session) return;
      const step = e.shiftKey ? 5 : 1;
      if (e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        void togglePlay();
      } else if (e.key === "ArrowLeft") session.transport.nudge(-step);
      else if (e.key === "ArrowRight") session.transport.nudge(step);
      else if (e.key === "Home" || e.key === "0") session.transport.seek(0);
      else if (e.key === "End") session.transport.seek(duration());
      else if (e.key === "l" || e.key === "L") toggleLoop();
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
      else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteSelection();
      }
      else if (e.key === "q" || e.key === "Q") quantizeSelection();
      else if (e.key === "v" || e.key === "V") tool.value = "select";
      else if (e.key === "d" || e.key === "D") tool.value = "draw";
      else if (e.key === "e" || e.key === "E") tool.value = "erase";
      else if (e.key === "Escape") selection.value = new Set();
      else if (e.key === "ArrowUp" && selection.value.size) {
        e.preventDefault();
        nudgeVelocity(e.shiftKey ? 16 : 4);
      } else if (e.key === "ArrowDown" && selection.value.size) {
        e.preventDefault();
        nudgeVelocity(e.shiftKey ? -16 : -4);
      }
      else if (e.key === "=" || e.key === "+") pxPerSecond.value = Math.min(400, pxPerSecond.value * 1.3);
      else if (e.key === "-") pxPerSecond.value = Math.max(4, pxPerSecond.value / 1.3);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const p = project.value;
  return (
    <div class="app">
      <TopBar onPlay={togglePlay} />
      {!p ? <Landing /> : <Editor levels={levels} />}
    </div>
  );
}

async function openProject(data: Project, source: Parameters<typeof loadProject>[1]) {
  loadProject(data, source);
  session?.dispose();
  await resumeAudio();
  session = new Session(data, source, mixer.value!, audioContext());
  status.value = { text: "Loading stems and samples…" };
  await session.load(notesByTrack.value);
  session.applyMixer(mixer.value!);
  setNotesListener((trackId, notes) => session?.setNotes(trackId, notes));
  status.value = { text: "Ready. Space plays; blend the lanes per track; drag notes to edit." };
  (window as any).__sf.session = session;
}

async function togglePlay() {
  if (!session) return;
  await resumeAudio();
  session.transport.toggle();
  playing.value = session.transport.playing;
}

function toggleLoop() {
  if (!session) return;
  const r = loopRegion.value;
  if (!r.on && r.b <= r.a) return;
  const on = !session.transport.loop.on;
  if (on) session.transport.setLoop(r.a, r.b);
  else session.transport.clearLoop();
  loopRegion.value = { ...r, on };
}

function TopBar({ onPlay }: { onPlay: () => void }) {
  const p = project.value;
  return (
    <div class="topbar">
      <span class="brand">🎛️ StemFlipper</span>
      {p && (
        <>
          <button class="primary" onClick={onPlay}>
            {playing.value ? "■ Stop" : "▶ Play"}
          </button>
          <span class="clock">{barsBeats(p.grid, playhead.value)}</span>
          <span class="dim small">
            {formatTime(playhead.value)} / {formatTime(p.song.duration)} · {p.grid.tempo} BPM ·{" "}
            {p.grid.time_signature} · {p.key.name}
          </span>
          <button class={loopRegion.value.on ? "on" : ""} onClick={toggleLoop}>
            ⟲ Loop
          </button>
          <button onClick={() => (pxPerSecond.value = Math.max(4, pxPerSecond.value / 1.3))}>−</button>
          <button onClick={() => (pxPerSecond.value = Math.min(400, pxPerSecond.value * 1.3))}>+</button>
          <button onClick={downloadMix} disabled={busy.value}>⬇︎ Mix WAV</button>
          <button onClick={downloadBundle} disabled={busy.value} title="MIDI + rendered mix + project.json">
            ⬇︎ Export
          </button>
          <span class="dim small">|</span>
          {(["select", "draw", "erase"] as const).map((t) => (
            <button
              key={t}
              class={tool.value === t ? "on" : ""}
              title={`${t} tool (${t[0].toUpperCase()})`}
              onClick={() => (tool.value = t)}
            >
              {t === "select" ? "⌖" : t === "draw" ? "✎" : "⌫"}
            </button>
          ))}
          <label class="small dim" title="snap edits to this subdivision">
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
          <button onClick={() => undo()} disabled={!canUndo()} title="undo (Cmd/Ctrl-Z)">↶</button>
          <button onClick={() => redo()} disabled={!canRedo()} title="redo (Cmd/Ctrl-Shift-Z)">↷</button>
          {edited.value ? (
            <span class="small" style={{ color: "var(--accent)" }} title="unsaved edits">
              edited · {historyDepth.value} step{historyDepth.value === 1 ? "" : "s"}
            </span>
          ) : null}
        </>
      )}
      <span class="spacer" />
      <span class={"small " + (status.value.error ? "stage-failed" : "dim")}>{status.value.text}</span>
    </div>
  );
}

async function downloadMix() {
  const p = project.value;
  const src = assetSource.value;
  const m = mixer.value;
  if (!p || !src || !m) return;
  busy.value = true;
  status.value = { text: "Rendering the mix…" };
  try {
    const buf = await renderMix(p, src, m, notesByTrack.value);
    const blob = encodeWav(buf, 16);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "stemflipper-mix.wav";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    status.value = { text: `Rendered ${formatTime(buf.duration)} (RMS ${bufferRms(buf).toFixed(3)}).` };
  } catch (e) {
    status.value = { text: `Render failed: ${(e as Error).message}`, error: true };
  } finally {
    busy.value = false;
  }
}

function Landing() {
  const [hover, setHover] = useState(false);
  const [preset, setPreset] = useState("balanced");
  const [six, setSix] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [token, setToken] = useState(backend.value.token || "");
  const [url, setUrl] = useState(backend.value.baseUrl);

  const run = async () => {
    if (!file) return;
    busy.value = true;
    status.value = { text: "Uploading…" };
    try {
      saveBackend({ baseUrl: url, token: token || null });
      const ref = await uploadFile(backend.value, file);
      const data = await runFlip(backend.value, ref, { preset: preset as any, six }, (msg) => {
        status.value = { text: msg };
      });
      const proj = data[3] as Project;
      if (!proj || !proj.tracks) throw new Error("the backend returned no project");
      await openProject(proj, {
        kind: "server",
        backend: backend.value,
        bundleRoot: proj._server?.bundle_root || "",
      });
    } catch (e) {
      status.value = { text: (e as Error).message, error: true };
    } finally {
      busy.value = false;
    }
  };

  return (
    <div class="scroller" style={{ padding: "24px", maxWidth: "780px", margin: "0 auto" }}>
      <h2>Upload a song</h2>
      <p class="dim">
        It is separated into stems (and the drum kit into its own pieces), transcribed to MIDI,
        and cut into samples. Then you can play the original stems against the reconstruction,
        blend them per track, and export.
      </p>
      <div
        class={"drop" + (hover ? " hover" : "")}
        onClick={() => document.getElementById("file")?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setHover(true);
        }}
        onDragLeave={() => setHover(false)}
        onDrop={(e) => {
          e.preventDefault();
          setHover(false);
          const f = e.dataTransfer?.files?.[0];
          if (f) setFile(f);
        }}
      >
        {file ? <b>{file.name}</b> : "Drop an audio file here, or click to choose one"}
        <input
          id="file"
          type="file"
          accept="audio/*"
          style={{ display: "none" }}
          onChange={(e) => setFile((e.target as HTMLInputElement).files?.[0] || null)}
        />
      </div>

      <div class="panel" style={{ marginTop: "16px" }}>
        <div class="row" style={{ flexWrap: "wrap", gap: "12px" }}>
          <label>
            Preset{" "}
            <select value={preset} onChange={(e) => setPreset((e.target as HTMLSelectElement).value)}>
              <option value="fast">fast</option>
              <option value="balanced">balanced</option>
              <option value="best">best</option>
            </select>
          </label>
          <label>
            <input type="checkbox" checked={six} onChange={(e) => setSix((e.target as HTMLInputElement).checked)} />{" "}
            split guitar &amp; piano
          </label>
          <button class="primary" disabled={!file || busy.value} onClick={run}>
            Flip it 🎚️
          </button>
        </div>
        <div class="row small dim" style={{ marginTop: "10px" }}>
          <label style={{ flex: 1 }}>
            Backend{" "}
            <input
              style={{ width: "260px" }}
              value={url}
              onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
            />
          </label>
          <label style={{ flex: 1 }}>
            HF token (optional){" "}
            <input
              type="password"
              style={{ width: "200px" }}
              value={token}
              onInput={(e) => setToken((e.target as HTMLInputElement).value)}
            />
          </label>
        </div>
        <p class="small dim">
          A token bills GPU time to your own Hugging Face account. Without one the shared
          anonymous pool is used, which is 2 GPU-minutes a day for everyone. You can also run
          the backend locally with <code>python app.py</code> and point this at
          <code> http://127.0.0.1:7860</code>.
        </p>
      </div>
    </div>
  );
}

function Editor({ levels }: { levels: Record<string, number> }) {
  const p = project.value!;
  const scrollRef = useRef<HTMLDivElement>(null);

  const seek = (t: number) => session?.transport.seek(t);
  const setLoop = (a: number, b: number) => {
    const lo = Math.max(0, Math.min(a, b));
    const hi = Math.min(p.song.duration, Math.max(a, b));
    loopRegion.value = { a: lo, b: hi, on: hi - lo > 0.05 };
    session?.transport.setLoop(lo, hi);
  };

  return (
    <div
      class="scroller"
      ref={scrollRef}
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
            onSeek={seek}
            onLoop={setLoop}
          />
        </div>
      </div>
      <div class="tracks">
        {p.tracks.map((t) => (
          <TrackRow key={t.id} track={t} level={levels[t.id] || 0} />
        ))}
      </div>
      <StageTrail />
    </div>
  );
}

function TrackRow({ track, level }: { track: Track; level: number }) {
  const m = mixer.value!;
  const notes = notesByTrack.value[track.id] || [];
  const hasNotes = notes.length > 0;

  const setLane = (lane: LaneId, value: number) => {
    updateMixer((s) => {
      s.lanes[track.id][lane] = value;
    });
    session?.applyMixer(mixer.value!);
  };
  const set = (fn: (s: typeof m) => void) => {
    updateMixer(fn);
    session?.applyMixer(mixer.value!);
  };

  return (
    <div class="track">
      <div class="trackhead">
        <div class="row">
          <span class="name">
            <span class="swatch" style={{ background: track.color }} />
            {track.name}
          </span>
          <span class="spacer" />
          <span class="small dim">
            {track.audio.silent ? "silent" : `${notes.length} notes`}
          </span>
        </div>
        <div class="small dim">
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
              onInput={(e) => setLane(lane.id, Number((e.target as HTMLInputElement).value) / 100)}
            />
            <span class="dim">{Math.round((m.lanes[track.id]?.[lane.id] ?? 0) * 100)}</span>
          </div>
        ))}

        <div class="lanefader" title="stereo position">
          <span>Pan</span>
          <input
            type="range" min="-100" max="100"
            value={Math.round((m.pan[track.id] ?? 0) * 100)}
            onInput={(e) => set((s) => { s.pan[track.id] = Number((e.target as HTMLInputElement).value) / 100; })}
          />
          <span class="dim">{panLabel(m.pan[track.id] ?? 0)}</span>
        </div>
        <div class="lanefader" title="track volume">
          <span>Volume</span>
          <input
            type="range" min="0" max="130"
            value={Math.round((m.volume[track.id] ?? 1) * 100)}
            onInput={(e) => set((s) => { s.volume[track.id] = Number((e.target as HTMLInputElement).value) / 100; })}
          />
          <span class="dim">{Math.round((m.volume[track.id] ?? 1) * 100)}</span>
        </div>

        <div class="row">
          <button
            class={m.solo[track.id] ? "on" : ""}
            title="solo this track"
            onClick={() => set((s) => { s.solo[track.id] = !s.solo[track.id]; })}
          >
            Solo
          </button>
          <button
            class={m.mute[track.id] ? "on" : ""}
            title="mute this track"
            onClick={() => set((s) => { s.mute[track.id] = !s.mute[track.id]; })}
          >
            Mute
          </button>
          {track.effects?.eq?.bands?.length ? (
            <button
              class={m.fx[track.id] ? "on" : ""}
              title="apply the EQ curve and reverb measured from this stem"
              onClick={() => set((s) => { s.fx[track.id] = !s.fx[track.id]; })}
            >
              FX
            </button>
          ) : null}
          <span class="spacer" />
          <div
            title="output level"
            style={{
              width: "7px", height: "20px", background: "#20242e", borderRadius: "2px",
              overflow: "hidden", display: "flex", alignItems: "flex-end",
            }}
          >
            <div style={{ width: "100%", height: `${Math.min(100, level * 130)}%`, background: "#6ad5c0" }} />
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
            marquee={marquee.track === track.id ? marquee.rect : null}
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
    <div class="panel" style={{ margin: "12px" }}>
      <div class="row">
        <b>How this was made</b>
        <span class="spacer" />
        <span class="small dim">
          preset {p.separation.preset} · {p.separation.gpu_seconds.toFixed(1)}s on {p.separation.device}
        </span>
      </div>
      <table style={{ marginTop: "8px" }}>
        <tbody>
          {p.separation.chain.map((c) => (
            <tr key={c.step}>
              <td>{c.step}</td>
              <td class="dim small">{c.model}</td>
              <td class="dim small">{c.seconds}s</td>
            </tr>
          ))}
        </tbody>
      </table>
      {notable.length > 0 && (
        <ul class="small">
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

function selectedIds(): Set<string> {
  return selection.value;
}

/** Drag state for a note edit in progress. */
const gesture: {
  kind: RollGesture["kind"] | null;
  trackId: string;
  from: { time: number; pitch: number };
  baseline: Note[];
  ids: Set<string>;
  key: string;
} = { kind: null, trackId: "", from: { time: 0, pitch: 0 }, baseline: [], ids: new Set(), key: "" };

const marquee: { track: string | null; rect: { t0: number; t1: number; p0: number; p1: number } | null } = {
  track: null,
  rect: null,
};

function startGesture(trackId: string, notes: Note[], g: RollGesture): void {
  selectedTrack.value = trackId;
  gesture.trackId = trackId;
  gesture.from = { time: g.time, pitch: g.pitch };
  gesture.baseline = notes.map((n) => ({ ...n }));
  gesture.key = `${g.kind}:${trackId}:${Date.now()}`;

  if (g.kind === "erase") {
    if (g.noteId) commitEdit(trackId, "erase", deleteNotes(notes, new Set([g.noteId])));
    gesture.kind = null;
    return;
  }
  if (g.kind === "draw") {
    const grid = project.value!.grid;
    const beat = 60 / (grid.tempo || 120);
    const length = snapDivision.value > 0 ? beat / snapDivision.value : beat / 4;
    const change = addNote(trackId, g.pitch, g.time, length, 96, grid, snapDivision.value);
    commitEdit(trackId, "draw", [change]);
    selection.value = new Set([change.id]);
    gesture.kind = null;
    return;
  }
  if (g.kind === "marquee") {
    if (!g.additive) selection.value = new Set();
    marquee.track = trackId;
    marquee.rect = { t0: g.time, t1: g.time, p0: g.pitch, p1: g.pitch };
    gesture.kind = "marquee";
    return;
  }

  // move / resize: make sure the grabbed note is selected
  let ids = new Set(selection.value);
  if (g.noteId && !ids.has(g.noteId)) {
    ids = g.additive ? new Set([...ids, g.noteId]) : new Set([g.noteId]);
  }
  selection.value = ids;
  gesture.ids = ids;
  gesture.kind = g.kind;
}

function moveGesture(trackId: string, time: number, pitch: number): void {
  if (gesture.kind === "marquee" && marquee.rect && marquee.track === trackId) {
    marquee.rect = { ...marquee.rect, t1: time, p1: pitch };
    const hits = notesIn(
      notesByTrack.value[trackId] || [],
      marquee.rect.t0, marquee.rect.t1, marquee.rect.p0, marquee.rect.p1,
    );
    selection.value = new Set(hits.map((n) => n.id));
    playhead.value = playhead.value; // nudge a redraw
    return;
  }
  if (!gesture.kind || gesture.trackId !== trackId || !gesture.ids.size) return;

  const grid = project.value!.grid;
  const dt = time - gesture.from.time;
  const dp = Math.round(pitch - gesture.from.pitch);
  let changes: Change[] = [];
  if (gesture.kind === "move") {
    changes = moveNotes(gesture.baseline, gesture.ids, dt, dp, grid, snapDivision.value);
  } else if (gesture.kind === "resize-end") {
    changes = resizeNotes(gesture.baseline, gesture.ids, dt, "end", grid, snapDivision.value);
  } else if (gesture.kind === "resize-start") {
    changes = resizeNotes(gesture.baseline, gesture.ids, dt, "start", grid, snapDivision.value);
  }
  if (changes.length) previewEdit(trackId, changes);
}

function endGesture(): void {
  if (gesture.kind === "marquee") {
    marquee.track = null;
    marquee.rect = null;
    gesture.kind = null;
    return;
  }
  if (!gesture.kind) return;
  // commit the whole drag as ONE undo step, from the pre-drag baseline
  const current = notesByTrack.value[gesture.trackId] || [];
  const byId = new Map(current.map((n) => [n.id, n]));
  const changes: Change[] = [];
  for (const before of gesture.baseline) {
    const after = byId.get(before.id);
    if (!after) continue;
    if (
      after.start !== before.start || after.end !== before.end ||
      after.pitch !== before.pitch || after.vel !== before.vel
    ) {
      changes.push({ id: before.id, before, after });
    }
  }
  gesture.kind = null;
  if (changes.length) commitEdit(gesture.trackId, "edit", changes, gesture.key);
}

function deleteSelection(): void {
  const trackId = selectedTrack.value;
  if (!trackId || !selection.value.size) return;
  const notes = notesByTrack.value[trackId] || [];
  commitEdit(trackId, "delete", deleteNotes(notes, selectedIds()));
  selection.value = new Set();
}

function quantizeSelection(): void {
  const trackId = selectedTrack.value;
  if (!trackId) return;
  const notes = notesByTrack.value[trackId] || [];
  const ids = selection.value.size ? selectedIds() : new Set(notes.map((n) => n.id));
  const division = snapDivision.value || 4;
  commitEdit(trackId, "quantise", quantizeNotes(notes, ids, project.value!.grid, division));
}

function nudgeVelocity(delta: number): void {
  const trackId = selectedTrack.value;
  if (!trackId || !selection.value.size) return;
  const notes = notesByTrack.value[trackId] || [];
  const current = notes.find((n) => selection.value.has(n.id));
  if (!current) return;
  commitEdit(trackId, "velocity", setVelocity(notes, selectedIds(), current.vel + delta));
}

async function downloadBundle() {
  const p = project.value;
  const src = assetSource.value;
  const m = mixer.value;
  if (!p || !src || !m) return;
  busy.value = true;
  try {
    const blob = await buildExportZip(p, src, m, notesByTrack.value, {
      midi: true,
      mix: true,
      stems: false,
      onProgress: (text) => (status.value = { text }),
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "stemflipper-export.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    status.value = { text: `Exported ${(blob.size / 1e6).toFixed(1)} MB (MIDI + mix + project).` };
  } catch (e) {
    status.value = { text: `Export failed: ${(e as Error).message}`, error: true };
  } finally {
    busy.value = false;
  }
}

function panLabel(p: number): string {
  if (Math.abs(p) < 0.02) return "C";
  return `${p < 0 ? "L" : "R"}${Math.round(Math.abs(p) * 100)}`;
}

export { openProject };
