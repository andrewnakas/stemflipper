/**
 * The transcription as written music.
 *
 * Everything here comes from the same notes the piano roll edits, so fixing a note in
 * Studio changes the score. The MusicXML download is the point of the exercise: a picture
 * of a stave is nice, but a file that opens in MuseScore, Sibelius, Dorico or Guitar Pro
 * is something you can actually work with.
 */

import { useEffect, useRef, useState } from "preact/hooks";
import { toMusicXml } from "../../export/musicxml";
import { buildPart, tuningFor, type Part, type Tuning } from "../../model/score";
import { notesByTrack, project as projectSignal } from "../../model/store";
import { Badge, Button, Card } from "../components/primitives";
import { Segmented } from "../components/Segmented";
import { navigate } from "../router";
import { themeVersion } from "../theme";
import { toast } from "../components/Toast";
import { drawPart } from "./render";

/** Rendering every bar of a long song at once is slow and unreadable; page through it. */
const MEASURES_PER_PAGE = 16;

export function ScoreView() {
  const project = projectSignal.value;
  const host = useRef<HTMLDivElement>(null);
  const [trackId, setTrackId] = useState<string | null>(null);
  const [showTab, setShowTab] = useState(true);
  const [page, setPage] = useState(0);
  const [perLine, setPerLine] = useState(4);
  const [busy, setBusy] = useState(false);
  const theme = themeVersion.value;

  if (!project) {
    navigate("home", { replace: true });
    return null;
  }

  const withNotes = project.tracks.filter((t) => (notesByTrack.value[t.id] || []).length > 0);
  const current = withNotes.find((t) => t.id === trackId) || withNotes[0];

  const notes = current ? notesByTrack.value[current.id] || [] : [];
  const tuning: Tuning | null = current && !isDrum(current) ? tuningFor(notes) : null;
  const part: Part | null = current
    ? buildPart(current.id, current.name, notes, project.grid, project.key, { isDrum: isDrum(current) })
    : null;

  const pages = part ? Math.max(1, Math.ceil(part.measures.length / MEASURES_PER_PAGE)) : 1;
  const from = page * MEASURES_PER_PAGE;

  useEffect(() => {
    setPage(0);
  }, [current?.id]);

  useEffect(() => {
    const el = host.current;
    if (!el || !part) return;
    let cancelled = false;
    setBusy(true);
    const width = el.clientWidth || 900;
    void drawPart(el, {
      part,
      tab: showTab ? tuning : null,
      width,
      measuresPerLine: perLine,
      firstMeasure: from,
      lastMeasure: from + MEASURES_PER_PAGE,
    })
      .catch((e) => {
        if (!cancelled) toast(`Could not draw the score: ${(e as Error).message}`, { tone: "error" });
      })
      .finally(() => !cancelled && setBusy(false));
    return () => {
      cancelled = true;
    };
  }, [current?.id, showTab, page, perLine, theme, tuning?.name]);

  const downloadXml = (allParts: boolean) => {
    const tracks = allParts ? withNotes : current ? [current] : [];
    const entries = tracks.flatMap((t) => {
      const ns = notesByTrack.value[t.id] || [];
      const p = buildPart(t.id, t.name, ns, project.grid, project.key, { isDrum: isDrum(t) });
      const tun = isDrum(t) ? null : tuningFor(ns);
      return tun && showTab ? [{ part: p }, { part: p, tab: tun }] : [{ part: p }];
    });
    const xml = toMusicXml(entries, {
      title: project.song.source_file.replace(/\.[^.]+$/, ""),
      tempo: project.grid.tempo,
    });
    const url = URL.createObjectURL(new Blob([xml], { type: "application/vnd.recordare.musicxml+xml" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(project.song.source_file.replace(/\.[^.]+$/, "") || "score")}${allParts ? "" : `-${current?.id}`}.musicxml`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  if (!withNotes.length) {
    return (
      <div class="screen screen--scroll">
        <div class="container container--narrow" style={{ paddingTop: "var(--s6)" }}>
          <Card title="Nothing to write down">
            <p class="small dim">
              No notes were transcribed for this song, so there is no score to draw.
            </p>
            <div style={{ marginTop: "var(--s3)" }}>
              <Button onClick={() => navigate("listen")}>← Back</Button>
            </div>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div class="screen screen--scroll">
      <div class="container" style={{ paddingTop: "var(--s4)", paddingBottom: "var(--s7)" }}>
        <div class="row wrap" style={{ gap: "var(--s3)", marginBottom: "var(--s3)" }}>
          <Button variant="ghost" onClick={() => navigate("listen")}>← Listen</Button>
          <Segmented
            label="Part"
            value={current?.id || ""}
            onChange={setTrackId}
            options={withNotes.map((t) => ({ value: t.id, label: t.name }))}
          />
          <span class="spacer" />
          <Button onClick={() => downloadXml(false)}>MusicXML (this part)</Button>
          <Button variant="primary" onClick={() => downloadXml(true)}>MusicXML (all parts)</Button>
        </div>

        <div class="row wrap small dim" style={{ gap: "var(--s3)", marginBottom: "var(--s3)" }}>
          {part ? (
            <>
              <Badge>{part.clef} clef</Badge>
              <Badge>{part.measures.length} bars</Badge>
              <Badge>{notes.length} notes</Badge>
            </>
          ) : null}
          {tuning ? (
            <label class="row xs">
              <input type="checkbox" checked={showTab} onChange={(e) => setShowTab((e.target as HTMLInputElement).checked)} />
              Tab ({tuning.name})
            </label>
          ) : (
            <span class="xs">
              {current && isDrum(current) ? "Drums are written on a percussion staff." : "Out of range for guitar or bass tab."}
            </span>
          )}
          <label class="row xs">
            bars per line
            <select value={String(perLine)} onChange={(e) => setPerLine(Number((e.target as HTMLSelectElement).value))}>
              {[2, 3, 4, 6].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
          {pages > 1 ? (
            <span class="row xs">
              <Button size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>‹</Button>
              bars {from + 1}–{Math.min(from + MEASURES_PER_PAGE, part!.measures.length)}
              <Button size="sm" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>›</Button>
            </span>
          ) : null}
          {busy ? <span class="xs">drawing…</span> : null}
        </div>

        <Card class="score-sheet">
          <div ref={host} class="score-host" />
        </Card>

        <p class="xs dim" style={{ marginTop: "var(--s3)" }}>
          Written from the transcription, so it inherits its mistakes — fix notes in Studio
          and the score follows. Rhythms are snapped to sixteenths, and each staff is a
          single voice: a note still sounding when the next one starts is cut short.
        </p>
      </div>
    </div>
  );
}

function isDrum(track: { kind: string }): boolean {
  return track.kind === "drums";
}
