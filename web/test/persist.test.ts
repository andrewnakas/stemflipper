import { afterEach, describe, expect, it, vi } from "vitest";
import { playableAssets, songId } from "../src/model/persist";
import type { AssetSource } from "../src/api/assets";
import type { Project } from "../src/model/types";

const source: AssetSource = { kind: "static", baseUrl: "/fixtures/demo" };

const kit = {
  type: "drumkit",
  name: "kit",
  pieces: {
    kick: { gm: 36, gm_all: [36], zones: [{ path: "instruments/drums/samples/kick_v1_rr1.wav", lovel: 1, hivel: 127, rr: 1 }] },
    snare: { gm: 38, gm_all: [38], zones: [{ path: "instruments/drums/samples/snare_v1_rr1.wav", lovel: 1, hivel: 127, rr: 1 }] },
  },
};

function track(id: string, over: Record<string, unknown> = {}) {
  return {
    id, name: id, role: id, kind: "pitched", color: "#888",
    audio: { src: `stems/${id}.flac`, silent: false, peak_db: -1, lufs: -18 },
    sub_stems: [], character: {},
    transcription: { engine: "x", fallback: null, n_notes: 0, quantized: true, subdivision: 4 },
    notes: [], f0: null,
    instrument: { sampler: null, sfz: null, dspreset: null, patch: null, vital: null },
    effects: null, loops: [], phrases: [], midi: `midi/${id}.mid`,
    ...over,
  };
}

function projectWith(tracks: unknown[]): Project {
  return {
    schema_version: 2,
    app: { name: "stemflipper", version: "2.0.0", created_utc: "2026-09-22T00:00:00Z" },
    song: { source_file: "song.mp3", duration: 30.5, sample_rate: 44100, channels: 2 },
    grid: { tempo: 120, time_signature: "4/4", beats: [], downbeats: [], tempo_map: [], source: "librosa" },
    key: { name: "A minor", tonic: 9, mode: "minor", confidence: 0.7 },
    chords: [], sections: [],
    separation: { preset: "fast", device: "cpu", gpu_seconds: 1, chain: [] },
    tracks, midi: { song: "midi/song.mid", chords: null }, exports: {}, stages: [],
  } as unknown as Project;
}

afterEach(() => vi.unstubAllGlobals());

describe("playableAssets", () => {
  it("lists the stems, MIDI and instruments the page actually loads", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const p = projectWith([track("bass"), track("drums")]);
    const paths = await playableAssets(p, source);
    expect(paths).toContain("stems/bass.flac");
    expect(paths).toContain("stems/drums.flac");
    expect(paths).toContain("midi/song.mid");
    expect(paths).toContain("midi/bass.mid");
  });

  it("follows a drum kit into its individual samples", async () => {
    // Zones live inside kit.json, not project.json — missing this stores a kit that
    // cannot make a sound.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(kit))));
    const p = projectWith([
      track("drums", { instrument: { sampler: "instruments/drums/kit.json", sfz: null, dspreset: null, patch: null, vital: null } }),
    ]);
    const paths = await playableAssets(p, source);
    expect(paths).toContain("instruments/drums/kit.json");
    expect(paths).toContain("instruments/drums/samples/kick_v1_rr1.wav");
    expect(paths).toContain("instruments/drums/samples/snare_v1_rr1.wav");
  });

  it("skips silent stems and survives an instrument file that has gone", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    const p = projectWith([
      track("vocals", { audio: { src: "stems/vocals.flac", silent: true, peak_db: null, lufs: null } }),
      track("bass", { instrument: { sampler: "instruments/bass/instrument.json", sfz: null, dspreset: null, patch: null, vital: null } }),
    ]);
    const paths = await playableAssets(p, source);
    expect(paths).not.toContain("stems/vocals.flac");
    expect(paths).toContain("stems/bass.flac");
    // the 404 must not take the whole save down
    expect(paths).toContain("instruments/bass/instrument.json");
  });

  it("does not list anything twice", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(kit))));
    const shared = { sampler: "instruments/drums/kit.json", sfz: null, dspreset: null, patch: null, vital: null };
    const p = projectWith([track("a", { instrument: shared }), track("b", { instrument: shared })]);
    const paths = await playableAssets(p, source);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe("songId", () => {
  it("is stable for the same run and different for another", () => {
    const a = projectWith([track("bass")]);
    expect(songId(a)).toBe(songId({ ...a }));
    const b = projectWith([track("bass")]);
    b.song = { ...b.song, duration: 31.5 };
    expect(songId(b)).not.toBe(songId(a));
  });
});
