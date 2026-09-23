/**
 * Everything the run produced, offered.
 *
 * The zip is the headline — it is what opens in a DAW — but the individual files matter
 * too: someone who only wants the acapella should not have to download 200 MB to get it.
 */

import { useState } from "preact/hooks";
import { assetUrl } from "../../api/assets";
import { bundleGroups } from "../../model/bundle";
import { writeMidi } from "../../export/midi";
import { zipWholeBundle } from "../../export/wholeBundle";
import { notesByTrack, project as projectSignal } from "../../model/store";
import { toast } from "../components/Toast";
import type { JobResult } from "../../model/job";
import { formatBytes } from "../../model/preflight";
import { Button, Card } from "../components/primitives";
import { Disclosure } from "../components/Disclosure";

export function Downloads({ result }: { result: JobResult }) {
  const groups = bundleGroups(result.project);
  // A run done in the browser has notes but no .mid files on disk. MIDI is the headline
  // promise, so generate it here rather than making people go through Studio's exporter.
  const hasMidiFiles = groups.some((g) => g.id === "midi");
  const noteCount = Object.values(notesByTrack.value).reduce((n, list) => n + list.length, 0);

  return (
    <Card class="stack" style={{ gap: "var(--s3)" }}>
      <div class="card__title">Download</div>

      {result.zipUrl ? (
        <>
          {/* No file count here: project.json lists 37 things for the demo while the zip
              carries 74, because the instrument files name samples of their own. The size
              is known and is the number that matters. */}
          <Button variant="primary" size="lg" href={result.zipUrl} download>
            Everything{result.zipBytes ? ` (${formatBytes(result.zipBytes)})` : ""}
          </Button>
          <p class="xs dim">
            One zip: stems, MIDI, samples, instruments, loops and the DAW project.
            {result.expiresAt ? ` This link works for about ${hoursLeft(result.expiresAt)}.` : ""}
          </p>
        </>
      ) : (
        <BuildZipButton result={result} />
      )}

      {!hasMidiFiles && noteCount > 0 ? <MidiButton project={result.project} /> : null}

      {groups.map((g) => (
        <Disclosure key={g.id} summary={<span><b>{g.title}</b> <span class="dim small">· {g.files.length}</span></span>}>
          <p class="xs dim" style={{ marginBottom: "var(--s2)" }}>{g.blurb}</p>
          <ul class="filelist">
            {g.files.map((f) => (
              <li key={f.rel}>
                <a href={assetUrl(result.source, f.rel)} download={f.filename}>
                  {f.label}
                </a>
                {f.hint ? <span class="xs dim"> — {f.hint}</span> : null}
              </li>
            ))}
          </ul>
        </Disclosure>
      ))}
    </Card>
  );
}

/**
 * Zip everything here, for a bundle with no server behind it — a demo, a song kept on
 * this device, or a run done in the browser.
 */
function BuildZipButton({ result }: { result: JobResult }) {
  const [state, setState] = useState<{
    kind: "idle" | "working" | "done";
    url?: string;
    done?: number;
    total?: number;
    files?: number;
    bytes?: number;
  }>({ kind: "idle" });

  if (state.kind === "done" && state.url) {
    return (
      <>
        <Button variant="primary" size="lg" href={state.url} download={zipName(result.project)}>
          Save the zip ({state.files} files, {formatBytes(state.bytes || 0)})
        </Button>
        <p class="xs dim">Built here from the files already on this device.</p>
      </>
    );
  }

  return (
    <>
      <Button
        variant="primary"
        size="lg"
        disabled={state.kind === "working"}
        onClick={() => {
          setState({ kind: "working", done: 0, total: 0 });
          let files = 0;
          void zipWholeBundle(result.project, result.source, (p) => {
            files = p.total + 1; // +1 for project.json, added at the end
            setState({ kind: "working", done: p.done, total: p.total });
          })
            .then((blob) =>
              setState({ kind: "done", url: URL.createObjectURL(blob), files, bytes: blob.size }),
            )
            .catch((e) => {
              setState({ kind: "idle" });
              toast((e as Error).message, { tone: "error" });
            });
        }}
      >
        {state.kind === "working"
          ? `Packing… ${state.done}${state.total ? ` of ${state.total}` : ""}`
          : "Everything"}
      </Button>
      <p class="xs dim">
        Packed in your browser — nothing is fetched from a server.
      </p>
    </>
  );
}

function zipName(project: JobResult["project"]): string {
  const base = (projectSignal.value?.song.source_file || project.song.source_file || "stemflipper")
    .replace(/\.[^.]+$/, "")
    .replace(/[^\w-]+/g, "-");
  return `${base || "stemflipper"}.zip`;
}

/** Build the multitrack MIDI from the notes currently loaded. */
function MidiButton({ project }: { project: JobResult["project"] }) {
  const [url, setUrl] = useState<string | null>(null);

  if (url) {
    return (
      <Button href={url} download={`${project.song.source_file.replace(/\.[^.]+$/, "")}.mid`} variant="primary">
        Save the MIDI
      </Button>
    );
  }
  return (
    <Button
      onClick={() => {
        const tracks = project.tracks.map((t) => ({
          name: t.id,
          isDrum: t.kind === "drums",
          notes: notesByTrack.value[t.id] || [],
        }));
        const bytes = writeMidi(tracks, project.grid, project.sections);
        setUrl(URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "audio/midi" })));
      }}
    >
      Make the MIDI file
    </Button>
  );
}

function hoursLeft(at: number): string {
  const h = Math.max(0, Math.round((at - Date.now()) / 3600_000));
  return h <= 1 ? "another hour" : `${h} hours`;
}
