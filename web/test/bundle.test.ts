import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { allBundlePaths, bundleGroups } from "../src/model/bundle";
import type { Project } from "../src/model/types";

/** The project.json from a real `fast` run against the live Space. */
const project = (JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/last_run_output.json", import.meta.url)), "utf8"),
) as unknown[])[3] as Project;

describe("bundle inventory, against a real run", () => {
  it("finds every kind of thing the pipeline produced", () => {
    const groups = bundleGroups(project);
    const byId = Object.fromEntries(groups.map((g) => [g.id, g]));
    expect(byId.stems.files).toHaveLength(4);
    expect(byId.midi.files.length).toBeGreaterThanOrEqual(5);
    expect(byId.instruments.files.length).toBeGreaterThanOrEqual(12);
    expect(byId.loops.files.length).toBeGreaterThanOrEqual(10);
    expect(byId.project.files.map((f) => f.rel)).toContain("project.dawproject");
  });

  it("puts the multitrack MIDI first and labels instruments by what opens them", () => {
    const midi = bundleGroups(project).find((g) => g.id === "midi")!;
    expect(midi.files[0].rel).toBe(project.midi.song);
    const inst = bundleGroups(project).find((g) => g.id === "instruments")!;
    expect(inst.files.some((f) => f.hint === "DecentSampler (free)")).toBe(true);
    expect(inst.files.every((f) => f.filename && !f.filename.includes("/"))).toBe(true);
  });

  it("drops groups that are empty rather than showing an empty heading", () => {
    const bare = { ...project, tracks: [], midi: { song: null, chords: null }, exports: {} } as unknown as Project;
    expect(bundleGroups(bare)).toHaveLength(0);
  });

  it("follows instrument files to the samples they name", async () => {
    // project.json lists the kit, not the 37 WAVs inside it. A zip built from the listed
    // paths alone would ship instruments that cannot make a sound.
    const kit = { pieces: { kick: { zones: [{ path: "instruments/drums/samples/kick.wav" }] } } };
    const paths = await allBundlePaths(project, async (rel) =>
      rel.endsWith(".json") ? kit : {},
    );
    expect(paths).toContain("instruments/drums/samples/kick.wav");
    expect(paths.length).toBeGreaterThan(bundleGroups(project).reduce((n, g) => n + g.files.length, 0));
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("does not let one unreadable instrument file lose the rest", async () => {
    const paths = await allBundlePaths(project, async () => {
      throw new Error("404");
    });
    expect(paths).toContain("stems/vocals.flac");
  });

  it("skips silent stems but keeps their MIDI out of the stem list", () => {
    const withSilent = {
      ...project,
      tracks: project.tracks.map((t, i) => (i === 0 ? { ...t, audio: { ...t.audio, silent: true } } : t)),
    } as Project;
    const stems = bundleGroups(withSilent).find((g) => g.id === "stems")!;
    expect(stems.files).toHaveLength(3);
  });
});
