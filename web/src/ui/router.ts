/**
 * Hash routing.
 *
 * Hash rather than history: the app is served from GitHub Pages behind a Cloudflare
 * proxy, and neither can rewrite unknown paths to index.html. The query string stays
 * the place for deep links (?fixture=, ?bundle=, ?backend=, OAuth's ?code=) so every
 * existing link keeps working.
 */

import { signal } from "@preact/signals";

export type RouteName = "home" | "run" | "listen" | "studio" | "score";

const ROUTES: RouteName[] = ["home", "run", "listen", "studio", "score"];

export function parseHash(hash: string): RouteName {
  const name = hash.replace(/^#\/?/, "").split("?")[0].split("/")[0];
  return (ROUTES as string[]).includes(name) ? (name as RouteName) : "home";
}

export const route = signal<RouteName>(parseHash(location.hash));

export function navigate(name: RouteName, opts: { replace?: boolean } = {}): void {
  const target = name === "home" ? "#/" : `#/${name}`;
  if (location.hash === target || (name === "home" && !location.hash)) {
    route.value = name;
    return;
  }
  if (opts.replace) history.replaceState(null, "", target);
  else location.hash = target;
  route.value = name;
}

if (typeof window !== "undefined") {
  window.addEventListener("hashchange", () => {
    route.value = parseHash(location.hash);
  });
}

/** Read a query param from the real URL (not the hash). */
export function param(name: string): string | null {
  return new URLSearchParams(location.search).get(name);
}
