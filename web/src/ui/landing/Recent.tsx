/** Songs kept in this browser. Empty until someone keeps one, so it costs nothing. */

import { useEffect, useState } from "preact/hooks";
import { deleteSong, listSongs, type SongSummary } from "../../model/persist";
import { openSaved } from "../../model/jobStore";
import { formatBytes } from "../../model/preflight";
import { formatDuration } from "../../model/preflight";
import { Button, Card } from "../components/primitives";
import { toast } from "../components/Toast";

export function Recent() {
  const [songs, setSongs] = useState<SongSummary[] | null>(null);

  const refresh = () => void listSongs().then(setSongs);
  useEffect(refresh, []);

  if (!songs || songs.length === 0) return null;

  return (
    <section class="section container container--narrow">
      <div class="section__head">
        <h2>Kept in this browser</h2>
        <p class="small dim" style={{ marginTop: "var(--s2)" }}>
          These play without the server, and without using any GPU time.
        </p>
      </div>
      <div class="stack" style={{ gap: "var(--s2)" }}>
        {songs.map((s) => (
          <Card key={s.id} quiet>
            <div class="row wrap" style={{ gap: "var(--s3)" }}>
              <div class="stack" style={{ minWidth: 0 }}>
                <b>{s.name}</b>
                <span class="xs dim">
                  {formatDuration(s.duration)} · {s.tracks} stems · {formatBytes(s.bytes)} ·{" "}
                  {new Date(s.savedAt).toLocaleDateString()}
                </span>
              </div>
              <span class="spacer" />
              <Button
                size="sm"
                onClick={() => {
                  void openSaved(s.id).catch((e) => toast((e as Error).message, { tone: "error" }));
                }}
              >
                Open
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Forget ${s.name}`}
                onClick={() => {
                  void deleteSong(s.id).then(refresh);
                }}
              >
                Forget
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}
