/**
 * Put the separated tracks on a timeline.
 *
 * audiosaw.com has a multitrack, non-destructive editor, and this page is served from the
 * same origin — so the stems can go straight onto its timeline rather than being
 * downloaded and dragged back in one at a time. Elsewhere (github.io, a local build) the
 * handoff has no shared storage to use, so it offers the project file instead.
 */

import { useState } from "preact/hooks";
import { buildAudiosawProject, editorAvailable, handoffToAudiosaw, openEditor } from "../../export/audiosawProject";
import type { JobResult } from "../../model/job";
import { formatBytes } from "../../model/preflight";
import { Button, Card } from "../components/primitives";
import { toast } from "../components/Toast";

export function SendToEditor({ result }: { result: JobResult }) {
  const playable = result.project.tracks.filter((t) => t.audio?.src && !t.audio.silent);
  const [chosen, setChosen] = useState<Set<string>>(new Set(playable.map((t) => t.id)));
  const [state, setState] = useState<{ kind: "idle" | "working"; detail?: string }>({ kind: "idle" });

  if (!playable.length) return null;

  const tracks = playable.filter((t) => chosen.has(t.id));
  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChosen(next);
  };

  const build = async () => {
    setState({ kind: "working", detail: "Packing…" });
    return buildAudiosawProject(result.project, result.source, tracks, {
      onProgress: (p) => setState({ kind: "working", detail: `Adding ${p.name}…` }),
    });
  };

  const name = `${result.project.song.source_file.replace(/\.[^.]+$/, "") || "stemflipper"}.audiosaw`;

  return (
    <Card class="stack" style={{ gap: "var(--s3)" }}>
      <div class="card__title">Edit on a timeline</div>
      <p class="small dim">
        Each stem becomes its own track, all starting together, in a non-destructive
        multitrack editor — cut, move, fade and mix without touching the files.
      </p>

      <div class="row wrap" style={{ gap: "var(--s3)" }}>
        {playable.map((t) => (
          <label key={t.id} class="row small" style={{ gap: "6px" }}>
            <input type="checkbox" checked={chosen.has(t.id)} onChange={() => toggle(t.id)} />
            <span class="swatch" style={{ background: t.color }} />
            {t.name}
          </label>
        ))}
      </div>

      <div class="row wrap" style={{ gap: "var(--s2)" }}>
        {editorAvailable() ? (
          <Button
            variant="primary"
            disabled={!tracks.length || state.kind === "working"}
            onClick={() => {
              void build()
                .then((blob) => handoffToAudiosaw(name, blob))
                .then(() => openEditor())
                .catch((e) => {
                  setState({ kind: "idle" });
                  toast(`Could not open the editor: ${(e as Error).message}`, { tone: "error" });
                });
            }}
          >
            {state.kind === "working" ? state.detail : `Open ${tracks.length} track${tracks.length === 1 ? "" : "s"} in the editor`}
          </Button>
        ) : null}

        <Button
          disabled={!tracks.length || state.kind === "working"}
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
                setState({ kind: "idle" });
                toast(`Saved ${name} (${formatBytes(blob.size)}) — open it in the AudioSaw editor.`);
              })
              .catch((e) => {
                setState({ kind: "idle" });
                toast((e as Error).message, { tone: "error" });
              });
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
