import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAudiosawProject } from "../src/export/audiosawProject";
import type { AssetSource } from "../src/api/assets";
import type { Project, Track } from "../src/model/types";

/**
 * audiosaw's editor reads project files with a small inline unzip that walks local file
 * headers and REFUSES anything that is not stored. Reimplemented here so the test fails
 * the same way the editor would.
 */
function readZipLikeAudiosaw(ab: ArrayBuffer): Record<string, Uint8Array> {
  const v = new DataView(ab);
  const out: Record<string, Uint8Array> = {};
  const dec = new TextDecoder();
  let o = 0;
  while (o + 30 <= ab.byteLength && v.getUint32(o, true) === 0x04034b50) {
    const method = v.getUint16(o + 8, true);
    const size = v.getUint32(o + 18, true);
    const nl = v.getUint16(o + 26, true);
    const xl = v.getUint16(o + 28, true);
    const name = dec.decode(new Uint8Array(ab, o + 30, nl));
    const start = o + 30 + nl + xl;
    if (method !== 0) throw new Error("This project file is compressed; re-save it from AudioSaw.");
    out[name] = new Uint8Array(ab, start, size);
    o = start + size;
  }
  return out;
}

function track(id: string, name: string, src: string | null, silent = false): Track {
  return {
    id, name, role: id, kind: "pitched", color: "#888",
    audio: { src, silent, peak_db: -3, lufs: null },
    sub_stems: [], character: {},
    transcription: { engine: "x", fallback: null, n_notes: 0, quantized: true, subdivision: 4 },
    notes: [], f0: null,
    instrument: { sampler: null, sfz: null, dspreset: null, patch: null, vital: null },
    effects: null, loops: [], phrases: [], midi: null,
  } as unknown as Track;
}

const project = {
  schema_version: 2,
  app: { name: "stemflipper", version: "3", created_utc: "" },
  song: { source_file: "another queen.mp3", duration: 30.25, sample_rate: 44100, channels: 2 },
  grid: { tempo: 120, time_signature: "4/4", beats: [], downbeats: [], tempo_map: [], source: "t" },
  key: { name: "C major", tonic: 0, mode: "major", confidence: 1 },
  chords: [], sections: [],
  separation: { preset: "x", device: "cpu", gpu_seconds: 0, chain: [] },
  tracks: [], midi: { song: null, chords: null }, exports: {}, stages: [],
} as unknown as Project;

const source: AssetSource = { kind: "static", baseUrl: "/fx" };

afterEach(() => vi.unstubAllGlobals());

function stubAudio() {
  let n = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4, ++n]))),
  );
}

describe("AudioSaw project export", () => {
  it("writes a zip the editor's own reader accepts", async () => {
    stubAudio();
    const tracks = [track("vocals", "Vocals", "stems/vocals.flac"), track("drums", "Drums", "stems/drums.flac")];
    const blob = await buildAudiosawProject(project, source, tracks);
    const entries = readZipLikeAudiosaw(await blob.arrayBuffer());
    expect(Object.keys(entries)).toContain("project.json");
    expect(Object.keys(entries).filter((k) => k.startsWith("sources/"))).toHaveLength(2);
  });

  it("puts every stem on its own track, starting together", async () => {
    stubAudio();
    const tracks = [track("vocals", "Vocals", "stems/vocals.flac"), track("bass", "Bass", "stems/bass.wav")];
    const blob = await buildAudiosawProject(project, source, tracks);
    const entries = readZipLikeAudiosaw(await blob.arrayBuffer());
    const p = JSON.parse(new TextDecoder().decode(entries["project.json"]));

    expect(p.v).toBe(1);
    expect(p.name).toBe("another queen");
    expect(p.tracks).toHaveLength(2);
    expect(p.tracks.map((t: { name: string }) => t.name)).toEqual(["Vocals", "Bass"]);
    for (const t of p.tracks) {
      expect(t.clips).toHaveLength(1);
      // Separated stems are the same length and start together; that is what makes them
      // line up on a timeline.
      expect(t.clips[0].start).toBe(0);
      expect(t.clips[0].duration).toBeCloseTo(30.25, 5);
    }
  });

  it("keeps every clip pointing at a source that is really in the file", async () => {
    stubAudio();
    const tracks = [track("a", "A", "stems/a.flac"), track("b", "B", "stems/b.flac")];
    const blob = await buildAudiosawProject(project, source, tracks);
    const entries = readZipLikeAudiosaw(await blob.arrayBuffer());
    const p = JSON.parse(new TextDecoder().decode(entries["project.json"]));
    for (const t of p.tracks) {
      const src = p.sources[t.clips[0].sourceId];
      expect(src, `clip references a missing source`).toBeTruthy();
      expect(entries[src.path], `${src.path} is not in the zip`).toBeTruthy();
    }
  });

  it("keeps the real extension, so the editor decodes what it actually got", async () => {
    stubAudio();
    const blob = await buildAudiosawProject(project, source, [track("a", "A", "stems/a.flac")]);
    const entries = readZipLikeAudiosaw(await blob.arrayBuffer());
    const p = JSON.parse(new TextDecoder().decode(entries["project.json"]));
    const src = Object.values(p.sources)[0] as { path: string; name: string };
    expect(src.path).toMatch(/\.flac$/);
    expect(src.name).toBe("A.flac");
  });

  it("skips silent stems and refuses a selection with nothing in it", async () => {
    stubAudio();
    const blob = await buildAudiosawProject(project, source, [
      track("a", "A", "stems/a.flac"),
      track("q", "Quiet", "stems/q.flac", true),
    ]);
    const p = JSON.parse(new TextDecoder().decode(readZipLikeAudiosaw(await blob.arrayBuffer())["project.json"]));
    expect(p.tracks).toHaveLength(1);

    await expect(buildAudiosawProject(project, source, [track("q", "Quiet", null)])).rejects.toThrow(/has any audio/i);
  });

  it("reports progress so a slow export can show it", async () => {
    stubAudio();
    const seen: string[] = [];
    await buildAudiosawProject(project, source, [track("a", "A", "stems/a.flac")], {
      onProgress: (p) => seen.push(p.name),
    });
    expect(seen.length).toBeGreaterThan(1);
  });
});
