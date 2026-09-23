/** Songs kept in this browser. Empty until someone keeps one, so it costs nothing. */

import { useEffect, useState } from "preact/hooks";
import { deleteSong, listSongs, type SongSummary } from "../../model/persist";
import { openBundle, openSaved, readResult, type SavedResult } from "../../model/jobStore";
import { formatBytes } from "../../model/preflight";
import { formatDuration } from "../../model/preflight";
import { Button, Card } from "../components/primitives";
import { toast } from "../components/Toast";

function hoursLeft(at: number | null): string {
  if (!at) return "a while";
  const h = Math.max(0, Math.round((at - Date.now()) / 3600_000));
  return h <= 1 ? "under an hour" : `about ${h} hours`;
}

export function Recent() {
  const [songs, setSongs] = useState<SongSummary[] | null>(null);
  // A run finished in this tab and the server has not pruned it yet: after a reload it is
  // still one click away, which it was not before.
  const [onServer, setOnServer] = useState<SavedResult | null>(readResult());

  const refresh = () => void listSongs().then(setSongs);
  useEffect(refresh, []);

  if ((!songs || songs.length === 0) && !onServer) return null;

  return (
    <section class="section container container--narrow">
      <div class="section__head">
        <h2>Your songs</h2>
        <p class="small dim" style={{ marginTop: "var(--s2)" }}>
          Kept songs play without the server, and without using any GPU time.
        </p>
      </div>
      <div class="stack" style={{ gap: "var(--s2)" }}>
        {onServer ? (
          <Card quiet>
            <div class="row wrap" style={{ gap: "var(--s3)" }}>
              <div class="stack" style={{ minWidth: 0 }}>
                <b>{onServer.name.replace(/\.[^.]+$/, "")}</b>
                <span class="xs dim">
                  still on the server · {hoursLeft(onServer.expiresAt)} left
                </span>
              </div>
              <span class="spacer" />
              <Button
                size="sm"
                onClick={() => {
                  void openBundle(onServer.bundleRoot, { baseUrl: onServer.baseUrl, token: null }).catch((e) => {
                    toast(`That run has expired: ${(e as Error).message}`, { tone: "error" });
                    setOnServer(null);
                  });
                }}
              >
                Open
              </Button>
            </div>
          </Card>
        ) : null}
        {(songs || []).map((s) => (
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
