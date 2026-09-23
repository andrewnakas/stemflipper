/**
 * Canvas colours come from CSS custom properties so the piano roll and ruler follow the
 * theme instead of hard-coding hex. `themeVersion` bumps when the scheme changes, which
 * the canvases depend on to force a repaint.
 */

import { signal } from "@preact/signals";

export const themeVersion = signal(0);

let probe: HTMLElement | null = null;

/** Resolve a CSS variable to its current computed value, with a fallback. */
export function cssVar(name: string, fallback = "#888"): string {
  if (typeof window === "undefined") return fallback;
  probe ||= document.documentElement;
  const value = getComputedStyle(probe).getPropertyValue(name).trim();
  return value || fallback;
}

if (typeof window !== "undefined" && window.matchMedia) {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    themeVersion.value++;
  });
}

export interface RollPalette {
  bg: string; row: string; grid: string; bar: string; label: string;
  note: string; noteDim: string; noteSel: string; playhead: string;
  accent: string; rulerBg: string; rulerText: string; rulerLoop: string; line: string;
}

let cached: RollPalette | null = null;
let cachedFor = -1;

/**
 * Canvas colours, read once per theme change rather than once per frame.
 *
 * The rolls redraw on every animation frame to move the playhead, and getComputedStyle is
 * far too expensive to call fourteen times in that loop.
 */
export function rollPalette(): RollPalette {
  if (cached && cachedFor === themeVersion.value) return cached;
  cached = {
    bg: cssVar("--roll-bg", "#16130f"),
    row: cssVar("--roll-row", "#1c1813"),
    grid: cssVar("--roll-grid", "#2b2419"),
    bar: cssVar("--roll-bar", "#453a28"),
    label: cssVar("--roll-label", "#9a9082"),
    note: cssVar("--roll-note", "#f59e4b"),
    noteDim: cssVar("--roll-note-dim", "#a8703a"),
    noteSel: cssVar("--roll-note-sel", "#fffaf1"),
    playhead: cssVar("--roll-playhead", "#6ad5c0"),
    accent: cssVar("--accent", "#f59e4b"),
    rulerBg: cssVar("--ruler-bg", "#1e1a15"),
    rulerText: cssVar("--ruler-text", "#c9c0b2"),
    rulerLoop: cssVar("--ruler-loop", "rgba(245,158,75,0.22)"),
    line: cssVar("--line", "#383024"),
  };
  cachedFor = themeVersion.value;
  return cached;
}

/** Studio renders dark whatever the page scheme is; call on mount/unmount. */
export function setStudioScheme(on: boolean): void {
  const el = document.documentElement;
  if (on) el.setAttribute("data-scheme", "studio");
  else el.removeAttribute("data-scheme");
  cached = null;
  themeVersion.value++;
}
