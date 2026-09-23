/**
 * The result: hear the stems, take the files, or open the editor.
 *
 * Deliberately not the editor. Most people want to listen, check it worked, and download —
 * dropping them straight into a piano roll with three faders per track was the single
 * biggest thing wrong with v2's flow.
 */

import { AUDIOSAW } from "../../config";
import { attribution, job, reset } from "../../model/jobStore";
import { assetLoad } from "../../model/playback";
import { project as projectSignal } from "../../model/store";
import { Button, Card, ProgressBar } from "../components/primitives";
import { navigate } from "../router";
import { AttributionLine } from "./Attribution";
import { Downloads } from "./Downloads";
import { KeepButton } from "./KeepButton";
import { SongFacts, SongHeader } from "./SongFacts";
import { StemRow } from "./StemRow";
import { TransportBar } from "./TransportBar";

export function ListenScreen() {
  const phase = job.value;
  const loading = assetLoad.value;
  const project = projectSignal.value;

  if (phase.kind === "loading" || (loading && !project)) {
    return (
      <div class="screen screen--scroll">
        <div class="container container--narrow" style={{ paddingTop: "var(--s7)" }}>
          <Card>
            <b>Loading it into your browser</b>
            <div style={{ marginTop: "var(--s3)" }}>
              <ProgressBar value={loading?.total ? loading.loaded / loading.total : null} label="Loading assets" />
            </div>
            <p class="small dim" style={{ marginTop: "var(--s2)" }}>
              {loading?.total ? `${loading.loaded} of ${loading.total} files` : "Fetching stems and samples…"}
            </p>
          </Card>
        </div>
      </div>
    );
  }

  if (!project || phase.kind !== "ready") {
    navigate("home", { replace: true });
    return null;
  }

  const result = phase.result;

  return (
    <div class="screen screen--scroll">
      <div class="container" style={{ paddingTop: "var(--s5)", paddingBottom: "var(--s7)" }}>
        <div class="row wrap" style={{ gap: "var(--s3)", marginBottom: "var(--s3)" }}>
          <div class="stack">
            <h2 style={{ fontSize: "var(--t-xl)" }}>
              {attribution.value?.title || songTitle(project.song.source_file)}
            </h2>
            <div style={{ marginTop: "var(--s2)" }}>
              <SongHeader project={project} />
            </div>
          </div>
          <span class="spacer" />
          <Button
            variant="ghost"
            onClick={() => {
              reset();
              navigate("home");
            }}
          >
            Flip another
          </Button>
          <Button variant="primary" onClick={() => navigate("studio")}>
            Open in Studio
          </Button>
        </div>
        <AttributionLine />
        <p class="small dim" style={{ marginBottom: "var(--s4)", marginTop: "var(--s2)" }}>
          Studio lets you edit the transcribed notes and blend the original stems against the
          synth and sampler rebuilds.
        </p>

        <div class="row wrap" style={{ gap: "var(--s2)", marginBottom: "var(--s3)" }}>
          <KeepButton />
          {result.expiresAt ? (
            <span class="xs dim">
              The download links above expire when the server clears this run.
            </span>
          ) : null}
        </div>

        <TransportBar duration={project.song.duration} />

        <div class="stems" style={{ marginTop: "var(--s4)" }}>
          {project.tracks.map((t) => (
            <StemRow key={t.id} track={t} duration={project.song.duration} />
          ))}
        </div>

        <div class="grid-2" style={{ marginTop: "var(--s5)", alignItems: "start" }}>
          <Downloads result={result} />
          <Card class="stack" style={{ gap: "var(--s3)" }}>
            <div class="card__title">About this song</div>
            <SongFacts project={project} />
            <p class="xs dim">
              Transcription is a starting point, not a finished score. Drums are the most
              accurate part; dense polyphony in "other" is the least. Fix anything that is
              wrong in Studio before exporting.
            </p>
            <p class="xs dim">
              Need a different format? <a href={AUDIOSAW.home}>AudioSaw's converters</a> run in
              your browser.
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}

function songTitle(sourceFile: string): string {
  return sourceFile.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ") || "Your song";
}
