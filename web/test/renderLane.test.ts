import { describe, expect, it } from "vitest";
import { availableLanes, isolate, renderedBytes } from "../src/export/renderLane";
import type { Note, Project, Track } from "../src/model/types";

function track(id: string, over: Partial<Track> = {}): Track {
  return {
    id, name: id, role: id, kind: "pitched", color: "#888",
    audio: { src: `stems/${id}.flac`, silent: false, peak_db: -3, lufs: null },
    sub_stems: [], character: {},
    transcription: { engine: "x", fallback: null, n_notes: 0, quantized: true, subdivision: 4 },
    notes: [], f0: null,
    instrument: { sampler: null, sfz: null, dspreset: null, patch: null, vital: null },
    effects: null, loops: [], phrases: [], midi: null,
    ...over,
  } as unknown as Track;
}

const note: Note = { id: "n", pitch: 60, start: 0, end: 1, vel: 90, conf: 0.9 };

const project = {
  song: { source_file: "s.mp3", duration: 30, sample_rate: 44100, channels: 2 },
  tracks: [track("vocals"), track("drums"), track("bass")],
} as unknown as Project;

describe("isolating one lane", () => {
  it("silences every other lane and every other track", () => {
    const s = isolate(project, "drums", "synth");
    expect(s.lanes.drums).toEqual({ original: 0, synth: 1, sampler: 0 });
    expect(s.lanes.vocals).toEqual({ original: 0, synth: 0, sampler: 0 });
    expect(s.lanes.bass).toEqual({ original: 0, synth: 0, sampler: 0 });
  });

  it("renders at unity, not at the mix's settings", () => {
    // A stem someone is about to edit should not arrive pre-panned, pre-faded or with the
    // master trim baked in.
    const s = isolate(project, "vocals", "original");
    expect(s.masterVolume).toBe(1);
    for (const id of ["vocals", "drums", "bass"]) {
      expect(s.volume[id]).toBe(1);
      expect(s.pan[id]).toBe(0);
      expect(s.mute[id]).toBe(false);
      expect(s.solo[id]).toBe(false);
      // The measured EQ and reverb belong to the mix, not to the stem.
      expect(s.fx[id]).toBe(false);
    }
  });

  it("leaves no track soloed, which would silence the one being rendered", () => {
    const s = isolate(project, "bass", "sampler");
    expect(Object.values(s.solo).some(Boolean)).toBe(false);
    expect(s.lanes.bass.sampler).toBe(1);
  });
});

describe("which lanes can make a sound", () => {
  it("offers the stem when there is audio", () => {
    expect(availableLanes(track("a"), [])).toEqual(["original"]);
  });

  it("offers the synth as soon as there are notes, patch or no patch", () => {
    // The synth lane falls back to a built-in voice when no patch was fitted.
    expect(availableLanes(track("a"), [note])).toEqual(["original", "synth"]);
  });

  it("offers the sampler only when a sample map exists", () => {
    const withMap = track("a", {
      instrument: { sampler: "instruments/a/instrument.json", sfz: null, dspreset: null, patch: null, vital: null },
    } as Partial<Track>);
    expect(availableLanes(withMap, [note])).toEqual(["original", "synth", "sampler"]);
  });

  it("offers nothing for a silent stem with no notes", () => {
    const silent = track("a", { audio: { src: "stems/a.flac", silent: true, peak_db: null, lufs: null } } as Partial<Track>);
    expect(availableLanes(silent, [])).toEqual([]);
  });
});

describe("size estimate", () => {
  it("is 16-bit stereo, which is what a render costs", () => {
    // Worth showing before someone commits: a four-minute lane is over 40 MB.
    expect(renderedBytes(60, 44100)).toBeCloseTo(44100 * 60 * 4 + 44, -2);
    expect(renderedBytes(240, 44100)).toBeGreaterThan(40e6);
  });
});

describe("toggling a selection", () => {
  /**
   * The component's toggle, as a pure function of the previous set. Written out here
   * because the bug it guards against is invisible in a single click: two ticks in one
   * tick both read the same stale state, and the second undoes the first.
   */
  const toggle = (prev: Set<string>, k: string): Set<string> => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    return next;
  };

  it("keeps both when two lanes are ticked in a row", () => {
    let s = new Set<string>(["vocals:original"]);
    s = toggle(s, "vocals:synth");
    s = toggle(s, "vocals:sampler");
    expect([...s].sort()).toEqual(["vocals:original", "vocals:sampler", "vocals:synth"]);
  });

  it("still unticks", () => {
    let s = new Set<string>(["a", "b"]);
    s = toggle(s, "a");
    expect([...s]).toEqual(["b"]);
  });
});
