/**
 * Put any combination of tracks and lanes on a timeline.
 *
 * audiosaw.com has a non-destructive multitrack editor and this page is served from the
 * same origin, so the stems can go straight onto its timeline rather than being downloaded
 * and dragged back in one at a time.
 *
 * The synth and sampler lanes have no file behind them — they only exist as a graph in
 * this tab — so choosing one renders it offline first. That is slower and much larger than
 * sending a stem, so the estimated size is shown before anyone commits to it.
 */

import { useState } from "preact/hooks";
import { buildAudiosawProject, editorAvailable, handoffToAudiosaw, openEditor } from "../../export/audiosawProject";
import { availableLanes, LANE_LABELS, renderedBytes, type LaneRef } from "../../export/renderLane";
import type { JobResult } from "../../model/job";
import { formatBytes } from "../../model/preflight";
import { notesByTrack } from "../../model/store";
import type { LaneId } from "../../model/types";
import { Button, Card } from "../components/primitives";
import { toast } from "../components/Toast";

const LANES: LaneId[] = ["original", "synth", "sampler"];

export function SendToEditor({ result }: { result: JobResult }) {
  const project = result.project;
  const rows = project.tracks
    .map((track) => ({ track, lanes: availableLanes(track, notesByTrack.value[track.id] || []) }))
    .filter((r) => r.lanes.length);

  // Start on the separated stems: that is what most people came for, and it needs no
  // rendering.
  const [chosen, setChosen] = useState<Set<string>>(
    new Set(rows.filter((r) => r.lanes.includes("original")).map((r) => `${r.track.id}:original`)),
  );
  const [state, setState] = useState<{ kind: "idle" | "working"; detail?: string }>({ kind: "idle" });

  if (!rows.length) return null;

  const key = (trackId: string, lane: LaneId) => `${trackId}:${lane}`;
  const toggle = (trackId: string, lane: LaneId) => {
    const next = new Set(chosen);
    const k = key(trackId, lane);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setChosen(next);
  };

  const items: LaneRef[] = rows.flatMap((r) =>
    r.lanes.filter((lane) => chosen.has(key(r.track.id, lane))).map((lane) => ({ track: r.track, lane })),
  );
  const rendered = items.filter((i) => i.lane !== "original").length;
  const estimate =
    items.filter((i) => i.lane === "original").length * (project.song.duration * 110_000) +
    rendered * renderedBytes(project.song.duration, project.song.sample_rate);

  const name = `${project.song.source_file.replace(/\.[^.]+$/, "") || "stemflipper"}.audiosaw`;

  const build = () => {
    setState({ kind: "working", detail: "Packing…" });
    return buildAudiosawProject(project, result.source, items, {
      notesByTrack: notesByTrack.value,
      onProgress: (p) =>
        setState({ kind: "working", detail: `${p.done + 1}/${p.total}: ${p.name}` }),
    });
  };

  const done = () => setState({ kind: "idle" });
  const fail = (e: unknown) => {
    done();
    toast((e as Error).message, { tone: "error" });
  };

  return (
    <Card class="stack" style={{ gap: "var(--s3)" }}>
      <div class="card__title">Edit on a timeline</div>
      <p class="small dim">
        Each one becomes its own track, all starting together, in a non-destructive
        multitrack editor — cut, move, fade and mix without touching the files.
      </p>

      <div class="scroll-x">
        <table class="lanegrid">
          <thead>
            <tr>
              <th />
              {LANES.map((lane) => (
                <th key={lane}>{LANE_LABELS[lane]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ track, lanes }) => (
              <tr key={track.id}>
                <th scope="row">
                  <span class="swatch" style={{ background: track.color }} /> {track.name}
                </th>
                {LANES.map((lane) => (
                  <td key={lane}>
                    {lanes.includes(lane) ? (
                      <input
                        type="checkbox"
                        aria-label={`${track.name} ${LANE_LABELS[lane]}`}
                        checked={chosen.has(key(track.id, lane))}
                        onChange={() => toggle(track.id, lane)}
                      />
                    ) : (
                      <span class="dim xs">—</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p class="xs dim">
        {items.length} track{items.length === 1 ? "" : "s"}, roughly {formatBytes(estimate)}.
        {rendered
          ? ` ${rendered} of them ${rendered === 1 ? "has" : "have"} to be rendered first, which takes a moment and makes a larger file.`
          : ""}
      </p>

      <div class="row wrap" style={{ gap: "var(--s2)" }}>
        {editorAvailable() ? (
          <Button
            variant="primary"
            disabled={!items.length || state.kind === "working"}
            onClick={() => {
              void build()
                .then((blob) => handoffToAudiosaw(name, blob))
                .then(openEditor)
                .catch(fail);
            }}
          >
            {state.kind === "working"
              ? state.detail
              : `Open ${items.length} track${items.length === 1 ? "" : "s"} in the editor`}
          </Button>
        ) : null}

        <Button
          disabled={!items.length || state.kind === "working"}
          onClick={() => {
            void build()
              .then((blob) => {
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = name;
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 10_000);
                done();
                toast(`Saved ${name} (${formatBytes(blob.size)}) — open it in the AudioSaw editor.`);
              })
              .catch(fail);
          }}
        >
          Download the project
        </Button>
      </div>

      {!editorAvailable() ? (
        <p class="xs dim">
          Opening it directly needs this page and the editor on the same site. From here,
          save the project and open it at{" "}
          <a href="https://audiosaw.com/audio-editor" rel="noopener">audiosaw.com/audio-editor</a>.
        </p>
      ) : null}
    </Card>
  );
}
