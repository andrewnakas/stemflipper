import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GPU_COST, GPU_FIXED_S, GPU_SIX_EXTRA, DAILY_QUOTA_S } from "../src/config";
import {
  dailyBudgetS, estimateGpuSeconds, estimateWallSeconds, fitsBudget,
  formatSeconds, formatWait, pickPreset, songsPerDay,
} from "../src/model/quota";
import type { Preset } from "../src/config";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/gpu_estimates.json", import.meta.url)), "utf8"),
) as {
  constants: { GPU_COST: Record<string, number>; GPU_FIXED_S: number; GPU_SIX_EXTRA: number };
  rows: { duration: number; preset: Preset; six: boolean; expected: number }[];
};

const PY_SOURCE = readFileSync(fileURLToPath(new URL("../../stemflipper/neural.py", import.meta.url)), "utf8");

describe("GPU estimate mirrors the Python", () => {
  it("agrees with estimate_gpu_seconds on every recorded case", () => {
    expect(fixture.rows.length).toBeGreaterThan(50);
    for (const row of fixture.rows) {
      expect(
        estimateGpuSeconds(row.duration, row.preset, row.six),
        `${row.duration}s ${row.preset}${row.six ? " six" : ""}`,
      ).toBe(row.expected);
    }
  });

  it("still matches the constants in neural.py itself", () => {
    // Reads the live Python source, so changing a cost there without changing config.ts
    // fails here rather than silently mispricing every run in the browser.
    const cost = PY_SOURCE.match(/^GPU_COST = (\{.*\})$/m)![1].replace(/'/g, '"');
    expect(JSON.parse(cost)).toEqual(GPU_COST);
    expect(Number(PY_SOURCE.match(/^GPU_FIXED_S = ([\d.]+)$/m)![1])).toBe(GPU_FIXED_S);
    expect(Number(PY_SOURCE.match(/^GPU_SIX_EXTRA = ([\d.]+)$/m)![1])).toBe(GPU_SIX_EXTRA);
    expect(fixture.constants.GPU_COST).toEqual(GPU_COST);
  });

  it("clamps the same way at both ends", () => {
    expect(estimateGpuSeconds(0, "fast")).toBe(30); // floor
    expect(estimateGpuSeconds(3600, "best", true)).toBe(191); // 8-minute cap, not an hour
    expect(estimateGpuSeconds(480, "best", true)).toBe(estimateGpuSeconds(3600, "best", true));
  });
});

describe("budgeting", () => {
  it("knows the published daily quotas", () => {
    expect(DAILY_QUOTA_S).toEqual({ anonymous: 120, free: 300, pro: 2400 });
    expect(dailyBudgetS("anonymous")).toBe(120);
  });

  it("lets an anonymous visitor run one balanced song of any accepted length", () => {
    for (const d of [30, 120, 210, 480]) expect(fitsBudget("anonymous", "balanced", d)).toBe(true);
  });

  it("counts songs per day honestly", () => {
    // 3.5-minute song: balanced asks 57 s, so 2 fit in the anonymous 120 s.
    expect(estimateGpuSeconds(210, "balanced")).toBe(57);
    expect(songsPerDay("anonymous", "balanced", 210)).toBe(2);
    expect(songsPerDay("free", "balanced", 210)).toBe(5);
    expect(songsPerDay("anonymous", "fast", 210)).toBe(4);
  });

  it("defaults to quality, dropping to fast only when a song would eat the whole day", () => {
    expect(pickPreset(210, "anonymous")).toBe("balanced");
    expect(pickPreset(480, "anonymous")).toBe("fast"); // 8 min balanced = 111 s of 120 s
    expect(pickPreset(480, "free")).toBe("balanced");
    expect(pickPreset(480, "pro")).toBe("balanced");
  });
});

describe("wall-clock pacing", () => {
  it("is anchored on the measured live runs", () => {
    // 16 s fixture: fast took ~26 s, balanced ~58 s end to end on the Space.
    expect(estimateWallSeconds(16, "fast")).toBeGreaterThan(18);
    expect(estimateWallSeconds(16, "fast")).toBeLessThan(35);
    expect(estimateWallSeconds(16, "balanced")).toBeGreaterThan(45);
    expect(estimateWallSeconds(16, "balanced")).toBeLessThan(70);
  });

  it("grows with length and with preset cost", () => {
    expect(estimateWallSeconds(210, "balanced")).toBeGreaterThan(estimateWallSeconds(210, "fast"));
    expect(estimateWallSeconds(210, "best")).toBeGreaterThan(estimateWallSeconds(210, "balanced"));
    expect(estimateWallSeconds(480, "fast")).toBeGreaterThan(estimateWallSeconds(60, "fast"));
  });
});

describe("formatting", () => {
  it("reads like a person wrote it", () => {
    expect(formatSeconds(45)).toBe("45 s");
    expect(formatSeconds(57)).toBe("57 s");
    expect(formatSeconds(90)).toBe("1 min 30 s");
    expect(formatSeconds(120)).toBe("2 min");
    expect(formatWait(56)).toBe("56 seconds");
    expect(formatWait(600)).toBe("10 minutes");
    expect(formatWait(5 * 3600 + 3 * 60)).toBe("5 hours 3 min");
    expect(formatWait(3600)).toBe("1 hour");
  });
});
