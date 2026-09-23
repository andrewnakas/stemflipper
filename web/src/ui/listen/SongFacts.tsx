/** What the analysis found, and how honest it was about getting there. */

import type { Project } from "../../model/types";
import { Badge } from "../components/primitives";
import { Disclosure } from "../components/Disclosure";

export function SongFacts({ project }: { project: Project }) {
  const notable = project.stages.filter((s) => s.status !== "ok");
  const chords = project.chords?.slice(0, 24) || [];

  return (
    <>
      {chords.length ? (
        <div class="chips" style={{ marginBottom: "var(--s3)" }}>
          {chords.map((c, i) => (
            <span class="chip" key={i} title={`${c.start.toFixed(1)}s`}>
              {c.label}
            </span>
          ))}
          {project.chords.length > chords.length ? <span class="chip chip--more">…</span> : null}
        </div>
      ) : null}

      <Disclosure summary={<span class="small">How this was made</span>}>
        <p class="small dim">
          Preset <b>{project.separation.preset}</b> · {project.separation.gpu_seconds.toFixed(1)} s of
          GPU on {project.separation.device}
          {project.separation.residual_db != null
            ? ` · stems add back up to the original within ${project.separation.residual_db.toFixed(0)} dB`
            : ""}
        </p>
        <table class="facts">
          <tbody>
            {project.separation.chain.map((c) => (
              <tr key={c.step}>
                <td>{c.step}</td>
                <td class="dim xs">{c.model}</td>
                <td class="dim xs tabular">{c.seconds}s</td>
              </tr>
            ))}
          </tbody>
        </table>
        {notable.length ? (
          <ul class="small" style={{ marginTop: "var(--s3)", paddingLeft: "1.1em" }}>
            {notable.map((s) => (
              <li key={s.name}>
                <span class={`stage-${s.status}`}>{s.name}: {s.status}</span>{" "}
                <span class="dim">— {s.detail}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p class="small dim" style={{ marginTop: "var(--s2)" }}>Every stage ran normally.</p>
        )}
      </Disclosure>
    </>
  );
}

export function SongHeader({ project }: { project: Project }) {
  return (
    <div class="row wrap" style={{ gap: "var(--s2)" }}>
      <Badge tone="accent">{Math.round(project.grid.tempo)} BPM</Badge>
      <Badge>{project.key.name}</Badge>
      <Badge>{project.grid.time_signature}</Badge>
      <Badge title={`grid from ${project.grid.source}`}>
        {project.grid.source === "beat_this" ? "beat-tracked" : "tempo estimated"}
      </Badge>
    </div>
  );
}
