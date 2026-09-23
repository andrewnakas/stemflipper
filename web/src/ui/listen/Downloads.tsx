/**
 * Everything the run produced, offered.
 *
 * The zip is the headline — it is what opens in a DAW — but the individual files matter
 * too: someone who only wants the acapella should not have to download 200 MB to get it.
 */

import { useState } from "preact/hooks";
import { assetUrl } from "../../api/assets";
import { bundleGroups, countFiles } from "../../model/bundle";
import { writeMidi } from "../../export/midi";
import { notesByTrack } from "../../model/store";
import type { JobResult } from "../../model/job";
import { formatBytes } from "../../model/preflight";
import { Button, Card } from "../components/primitives";
import { Disclosure } from "../components/Disclosure";

export function Downloads({ result }: { result: JobResult }) {
  const groups = bundleGroups(result.project);
  const total = countFiles(result.project);
  // A run done in the browser has notes but no .mid files on disk. MIDI is the headline
  // promise, so generate it here rather than making people go through Studio's exporter.
  const hasMidiFiles = groups.some((g) => g.id === "midi");
  const noteCount = Object.values(notesByTrack.value).reduce((n, list) => n + list.length, 0);

  return (
    <Card class="stack" style={{ gap: "var(--s3)" }}>
      <div class="card__title">Download</div>

      {result.zipUrl ? (
        <>
          <Button variant="primary" size="lg" href={result.zipUrl} download>
            Everything ({total} files{result.zipBytes ? `, ${formatBytes(result.zipBytes)}` : ""})
          </Button>
          <p class="xs dim">
            One zip: stems, MIDI, samples, instruments, loops and the DAW project.
            {result.expiresAt ? ` This link works for about ${hoursLeft(result.expiresAt)}.` : ""}
          </p>
        </>
      ) : (
        <p class="small dim">Pick what you need — these are files on this device, not a download.</p>
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
