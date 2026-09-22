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

/** Studio renders dark whatever the page scheme is; call on mount/unmount. */
export function setStudioScheme(on: boolean): void {
  const el = document.documentElement;
  if (on) el.setAttribute("data-scheme", "studio");
  else el.removeAttribute("data-scheme");
  themeVersion.value++;
}
