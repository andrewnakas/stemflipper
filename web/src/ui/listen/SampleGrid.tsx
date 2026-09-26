/**
 * The samples this track's Sampler lane is playing, as things you can click.
 *
 * The bundle has always contained these — a drum kit split into kick, snare, toms, hats, ride
 * and crash, each with velocity layers and round robins, or a pitched instrument as one sample
 * per root note — but they were only ever filenames in a download list. Cut from this song's own
 * audio, they are the most surprising thing in the bundle, and hearing one is the fastest way to
 * understand what the Sampler fader is doing.
 */

import { useEffect, useState } from "preact/hooks";
import { assetUrl, fetchJson } from "../../api/assets";
import { assetSource } from "../../model/store";
import type { DrumKit, Instrument, Multisample, Track } from "../../model/types";
import { audition } from "../audition";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function noteName(midi: number): string {
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

interface Pad {
  label: string;
  sub: string;
  /** Every take behind this pad — velocity layers and round robins. Clicking cycles them. */
  paths: string[];
}

function padsOf(inst: Instrument): Pad[] {
  if (inst.type === "drumkit") {
    const kit = inst as DrumKit;
    return Object.entries(kit.pieces).map(([name, piece]) => ({
      label: name === "hh" ? "Hi-hat" : name.charAt(0).toUpperCase() + name.slice(1),
      sub: `${piece.zones.length} take${piece.zones.length === 1 ? "" : "s"}`,
      paths: piece.zones.map((z) => z.path),
    }));
  }
  const ms = inst as Multisample;
  // One pad per root note; velocity layers on the same root sit behind it.
  const byRoot = new Map<number, string[]>();
  for (const z of ms.zones) {
    const root = z.root ?? 60;
    const list = byRoot.get(root) || [];
    list.push(z.path);
    byRoot.set(root, list);
  }
  return [...byRoot.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([root, paths]) => ({
      label: noteName(root),
      sub: paths.length > 1 ? `${paths.length} layers` : "",
      paths,
    }));
}

export function SampleGrid({ track }: { track: Track }) {
  const source = assetSource.value;
  const rel = track.instrument.sampler;
  const [inst, setInst] = useState<Instrument | null>(null);
  const [failed, setFailed] = useState(false);
  const [sounding, setSounding] = useState<string | null>(null);
  /** Which take to play next, per pad, so repeated clicks walk the round robins. */
  const [turn, setTurn] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!rel || !source) return;
    let cancelled = false;
    fetchJson<Instrument>(assetUrl(source, rel))
      .then((i) => {
        if (!cancelled) setInst(i);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [rel, source]);

  if (!rel) {
    return (
      <p class="xs dim">
        No samples for this part. They are cut on the server — a run in your browser separates and
        transcribes, but does not build instruments.
      </p>
    );
  }
  if (failed) return <p class="xs dim">This track's sample map could not be loaded.</p>;
  if (!inst) return <p class="xs dim">Loading samples…</p>;

  const pads = padsOf(inst);
  if (!pads.length) return <p class="xs dim">This instrument has no zones.</p>;

  return (
    <div class="pads">
      {pads.map((pad) => {
        const i = (turn[pad.label] || 0) % pad.paths.length;
        const path = pad.paths[i];
        return (
          <button
            type="button"
            key={pad.label}
            class={"pad" + (sounding === path ? " pad--on" : "")}
            style={{ borderColor: sounding === path ? track.color : undefined }}
            title={`${path.split("/").pop()} — click to hear it`}
            onClick={async () => {
              if (!source) return;
              setTurn((t) => ({ ...t, [pad.label]: (t[pad.label] || 0) + 1 }));
              setSounding(path);
              try {
                await audition(source, path);
              } catch {
                /* a missing sample just does not sound */
              }
              setSounding((p) => (p === path ? null : p));
            }}
          >
            <b class="pad__label">{pad.label}</b>
            {pad.sub ? <span class="pad__sub xs dim">{pad.sub}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
