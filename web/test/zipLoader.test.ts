import { zipSync, strToU8 } from "fflate";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { assetUrl } from "../src/api/assets";
import { bundlePrefix, looksLikeZip, openBundle } from "../src/model/zipLoader";

/** node has no object URLs; hand out a stable fake so paths can be asserted. */
beforeAll(() => {
  let n = 0;
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: () => `blob:fake/${n++}`,
    revokeObjectURL: () => undefined,
  });
});

const project = {
  schema_version: 2,
  app: { name: "stemflipper", version: "2.0.0", created_utc: "now" },
  song: { source_file: "song.mp3", duration: 30, sample_rate: 44100, channels: 2 },
  grid: { tempo: 120, time_signature: "4/4", beats: [], downbeats: [], tempo_map: [], source: "librosa" },
  key: { name: "A minor", tonic: 9, mode: "minor", confidence: 0.7 },
  chords: [], sections: [],
  separation: { preset: "fast", device: "cpu", gpu_seconds: 1, chain: [] },
  tracks: [{ id: "bass", name: "Bass", role: "bass", kind: "pitched", color: "#888",
    audio: { src: "stems/bass.flac", silent: false, peak_db: -1, lufs: -18 },
    sub_stems: [], character: {},
    transcription: { engine: "x", fallback: null, n_notes: 1, quantized: true, subdivision: 4 },
    notes: [[36, 0, 1, 90, 0.9]], f0: null,
    instrument: { sampler: null, sfz: null, dspreset: null, patch: null, vital: null },
    effects: null, loops: [], phrases: [], midi: "midi/bass.mid" }],
  midi: { song: "midi/song.mid", chords: null },
  exports: {}, stages: [],
  _server: { bundle_root: "/tmp/should-be-stripped" },
};

function bundle(prefix = "song/") {
  return zipSync({
    [`${prefix}project.json`]: strToU8(JSON.stringify(project)),
    [`${prefix}stems/bass.flac`]: new Uint8Array([1, 2, 3, 4]),
    [`${prefix}midi/song.mid`]: new Uint8Array([77, 84, 104, 100]),
  });
}

describe("bundlePrefix", () => {
  it("finds the folder the pipeline zipped everything into", () => {
    expect(bundlePrefix(["song/project.json", "song/stems/a.flac"])).toBe("song/");
  });
  it("handles a bundle zipped at the root", () => {
    expect(bundlePrefix(["project.json", "stems/a.flac"])).toBe("");
  });
  it("is empty when there is no manifest at all", () => {
    expect(bundlePrefix(["notes.txt"])).toBe("");
  });
});

describe("looksLikeZip", () => {
  it("recognises the PK header and rejects anything else", () => {
    expect(looksLikeZip(bundle())).toBe(true);
    expect(looksLikeZip(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(false);
    expect(looksLikeZip(new Uint8Array([]))).toBe(false);
  });
});

describe("openBundle", () => {
  it("reads the project and maps every file to a URL the engine can fetch", () => {
    const opened = openBundle(bundle());
    expect(opened.project.tracks).toHaveLength(1);
    expect(opened.source.kind).toBe("blob");
    // the paths project.json uses must resolve, with the zip's folder stripped
    expect(assetUrl(opened.source, "stems/bass.flac")).toMatch(/^blob:/);
    expect(assetUrl(opened.source, "midi/song.mid")).toMatch(/^blob:/);
    opened.dispose();
  });

  it("works the same for a bundle zipped without a folder", () => {
    const opened = openBundle(bundle(""));
    expect(assetUrl(opened.source, "stems/bass.flac")).toMatch(/^blob:/);
    opened.dispose();
  });

  it("drops _server, which points at a path on a machine we are not talking to", () => {
    const opened = openBundle(bundle());
    expect(opened.project._server).toBeUndefined();
    opened.dispose();
  });

  it("explains what is wrong instead of throwing something internal", () => {
    expect(() => openBundle(new Uint8Array([1, 2, 3, 4, 5]))).toThrow(/not a zip/i);
    const noManifest = zipSync({ "readme.txt": strToU8("hello") });
    expect(() => openBundle(noManifest)).toThrow(/project\.json/i);
    const damaged = zipSync({ "project.json": strToU8("{not json") });
    expect(() => openBundle(damaged)).toThrow(/damaged/i);
    const noTracks = zipSync({ "project.json": strToU8('{"schema_version":2}') });
    expect(() => openBundle(noTracks)).toThrow(/tracks/i);
  });
});
