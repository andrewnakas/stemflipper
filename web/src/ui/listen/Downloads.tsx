/**
 * Everything the run produced, offered.
 *
 * The zip is the headline — it is what opens in a DAW — but the individual files matter
 * too: someone who only wants the acapella should not have to download 200 MB to get it.
 */

import { assetUrl } from "../../api/assets";
import { bundleGroups, countFiles } from "../../model/bundle";
import type { JobResult } from "../../model/job";
import { formatBytes } from "../../model/preflight";
import { Button, Card } from "../components/primitives";
import { Disclosure } from "../components/Disclosure";

export function Downloads({ result }: { result: JobResult }) {
  const groups = bundleGroups(result.project);
  const total = countFiles(result.project);

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
        <p class="small dim">Pick what you need — this example is served as individual files.</p>
      )}

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

function hoursLeft(at: number): string {
  const h = Math.max(0, Math.round((at - Date.now()) / 3600_000));
  return h <= 1 ? "another hour" : `${h} hours`;
}
