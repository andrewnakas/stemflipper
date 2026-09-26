/** The front door: what this is, one obvious control, and an example you can hear now. */

import { useEffect, useState } from "preact/hooks";
import { AUDIOSAW, DEMO_FIXTURE, LIMITS } from "../../config";
import { auth, tier } from "../../model/auth";
import { attribution, job, openFixture, pickFile, type Attribution } from "../../model/jobStore";
import { dailyBudgetS, estimateGpuSeconds, formatSeconds, songsPerDay } from "../../model/quota";
import { Button, Card } from "../components/primitives";
import { Notice } from "../components/Notice";
import { toast } from "../components/Toast";
import { fetchJson } from "../../api/assets";
import { DropVeil, DropZone } from "./DropZone";
import { Recent } from "./Recent";

const TYPICAL_SONG_S = 210; // 3:30, for the "how many songs a day" sums

export function Landing() {
  const [loadingDemo, setLoadingDemo] = useState(false);

  // Name the example before anyone clicks it: "Hear an example" is a weaker invitation
  // than hearing whose song it is. Cheap — a few hundred bytes of JSON.
  useEffect(() => {
    if (attribution.value) return;
    void fetchJson<Attribution>(`${import.meta.env.BASE_URL}fixtures/${DEMO_FIXTURE}/attribution.json`)
      .then((a) => (attribution.value = a))
      .catch(() => undefined);
  }, []);

  // pickFile decides where a file leads: a song goes to the run screen, a bundle zip
  // opens straight into Listen. Navigating here as well overrode the latter.
  const take = (file: File) => void pickFile(file);

  const hearExample = async () => {
    setLoadingDemo(true);
    try {
      await openFixture(DEMO_FIXTURE);
    } catch (e) {
      toast(`Could not load the example: ${(e as Error).message}`, { tone: "error" });
    } finally {
      setLoadingDemo(false);
    }
  };

  return (
    <div class="screen screen--scroll">
      <DropVeil onFile={take} label="Drop your song" />

      <section class="hero container container--narrow">
        <h1 class="hero__title">Turn any song into stems, MIDI and playable instruments.</h1>
        <p class="hero__sub">
          Drop a track. It comes back split into stems and transcribed to MIDI — on this
          device if you like, with nothing uploaded and no limit.
        </p>
        <DropZone onFile={take} disabled={job.value.kind === "uploading"} />
        <div class="hero__actions">
          <Button variant="ghost" onClick={hearExample} disabled={loadingDemo}>
            {loadingDemo ? "Loading…" : "▶ Hear an example"}
          </Button>
        </div>
        {attribution.value ? (
          <p class="xs dim" style={{ marginTop: "var(--s2)" }}>
            “{attribution.value.title}” by {attribution.value.artist} ·{" "}
            <a href={attribution.value.licenseUrl} rel="license noopener">
              {attribution.value.license}
            </a>
          </p>
        ) : null}
      </section>

      <section class="section container">
        <div class="section__head">
          <h2>What you get</h2>
        </div>
        <div class="grid-cards">
          <Card title="Stems">
            <p class="card__body small">
              Vocals, drums, bass and the rest — in your browser, quicker than the song is
              long. On the server the drum kit is split again into kick, snare, toms, hi-hat,
              ride and crash, and you get samples and instruments too.
            </p>
          </Card>
          <Card title="MIDI">
            <p class="card__body small">
              One file per stem plus a multitrack score, with a real tempo map, time signature,
              section markers and drums on channel 10.
            </p>
          </Card>
          <Card title="Instruments">
            <p class="card__body small">
              A drum kit and multisampled instruments built from this song's own audio, as SFZ,
              DecentSampler and Vital presets. Server only — cutting samples needs the
              four-stem split.
            </p>
          </Card>
          <Card title="Loops and phrases">
            <p class="card__body small">
              Bar-aligned loops cut at real downbeats and named with tempo and key, plus vocal
              chops bounded by silence. Server only.
            </p>
          </Card>
        </div>
      </section>

      <section class="section container">
        <div class="section__head">
          <h2>How it works</h2>
        </div>
        <div class="howto">
          <div class="howto__item">
            <b>Separate</b>
            <p class="small dim">
              A neural model pulls the vocal out, and on the server a second one splits what is
              left into drums, bass and the rest — then the kit into its own pieces, which is
              what makes the drum transcription accurate.
            </p>
          </div>
          <div class="howto__item">
            <b>Transcribe</b>
            <p class="small dim">
              Each stem gets the engine that suits it — pitch tracking for bass and vocals, a
              dedicated model for piano, per-piece onsets for drums — and the answer is checked.
            </p>
          </div>
          <div class="howto__item">
            <b>Rebuild</b>
            <p class="small dim">
              On the server, samples are cut from the stems and mapped into instruments, so the
              reconstruction plays with this song's own sounds. Either way you can edit the
              notes and export.
            </p>
          </div>
        </div>
        <div style={{ marginTop: "var(--s5)" }}>
          <Notice tone="info" title="You choose where it runs">
            <b>In your browser</b> — four stems, each transcribed to MIDI. Nothing is uploaded,
            there is no limit, and it needs no account. Roughly the length of the song itself —
            quicker than that with a graphics card.
            <br />
            <b>On the server</b> — four stems, the drum kit split into its pieces, plus samples,
            instruments and loops. Your song is uploaded to a Hugging Face Space and deleted
            within 6 hours, and the free GPU time is rationed per day.
          </Notice>
        </div>
      </section>

      <Recent />

      <FreeTier />

      <section class="section container container--narrow">
        <p class="small dim center">
          Limits: {LIMITS.maxMinutes} minutes and {LIMITS.maxBytesLabel} per file. Longer song? <a href={AUDIOSAW.trim}>Trim it first</a>. Too big?{" "}
          <a href={AUDIOSAW.compress}>Compress it</a>. Both are free and run in your browser.
        </p>
        <p class="small dim center" style={{ marginTop: "var(--s4)" }}>
          Research and educational demo. Transcription is an editable starting point, not a
          finished score. · <a href={AUDIOSAW.home}>More audio tools</a> ·{" "}
          <a href="https://github.com/andrewnakas/stemflipper">Source</a>
        </p>
      </section>
    </div>
  );
}

/** Honest arithmetic about the free GPU allowance, using the visitor's own tier. */
function FreeTier() {
  const you = tier();
  const signedIn = auth.value.status !== "anonymous";
  const rows: { tier: "anonymous" | "free" | "pro"; label: string }[] = [
    { tier: "anonymous", label: "Not signed in" },
    { tier: "free", label: "Free Hugging Face account" },
    { tier: "pro", label: "Hugging Face PRO" },
  ];

  return (
    <section class="section container container--narrow">
      <div class="section__head">
        <h2>The server's daily limit</h2>
        <p class="small dim" style={{ marginTop: "var(--s2)" }}>
          Running in your browser has no limit at all. The four-stem version uses Hugging
          Face's free GPU, and that time is rationed per person per day — signing in spends
          your own allowance instead of the shared one, which is why everyone gets more.
        </p>
      </div>
      <Card flat>
        <div class="scroll-x">
        <table class="quota-table">
          <thead>
            <tr>
              <th>You are</th>
              <th>GPU time a day</th>
              <th>Songs of about 3:30</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.tier} class={r.tier === you ? "is-you" : ""}>
                <td>
                  {r.label}
                  {r.tier === you ? <span class="dim"> — you</span> : null}
                </td>
                <td class="tabular">{formatSeconds(dailyBudgetS(r.tier))}</td>
                <td class="tabular">{songsPerDay(r.tier, "balanced", TYPICAL_SONG_S)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        <p class="xs dim" style={{ marginTop: "var(--s3)" }}>
          A 3:30 song costs about {estimateGpuSeconds(TYPICAL_SONG_S, "balanced")} seconds of GPU
          on the Balanced setting. You are only charged for time actually used.
          {signedIn ? "" : " Signing in asks for your name only — nothing else."}
        </p>
      </Card>
    </section>
  );
}
