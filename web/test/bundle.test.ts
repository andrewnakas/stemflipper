import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bundleGroups, countFiles } from "../src/model/bundle";
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
    expect(countFiles(project)).toBeGreaterThan(30);
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
    expect(countFiles(bare)).toBe(0);
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
