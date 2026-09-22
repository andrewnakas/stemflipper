/**
 * Who is signed in, and which token the backend calls should carry.
 *
 * Storage: an OAuth session goes in localStorage so a visitor stays signed in across
 * tabs and reloads — it is scoped to `openid profile`, expires in 8 hours, and the worst
 * a leak could do is let someone spend that account's daily GPU minutes. A hand-pasted
 * token is a real HF token with whatever permissions the user gave it, so it defaults to
 * sessionStorage and only persists if they explicitly ask.
 */

import { signal } from "@preact/signals";
import type { Tier } from "../config";
import { fetchUser, handleRedirectIfPresent, isConfigured, type HfSession, type HfUser } from "../api/hfAuth";

const SESSION_KEY = "sf.auth";
const TOKEN_KEY = "sf.token";
const LEGACY_BACKEND_KEY = "stemflipper.backend";

export type AuthState =
  | { status: "anonymous" }
  | { status: "signed_in"; token: string; expiresAt: number; user: HfUser }
  | { status: "token"; token: string; remembered: boolean };

export const auth = signal<AuthState>({ status: "anonymous" });

export function effectiveToken(): string | null {
  const a = auth.value;
  if (a.status === "signed_in") return Date.now() < a.expiresAt ? a.token : null;
  if (a.status === "token") return a.token;
  return null;
}

export function tier(): Tier {
  const a = auth.value;
  if (a.status === "signed_in") return a.user.isPro ? "pro" : "free";
  // A pasted token is at least a free account; we cannot see PRO without a profile call.
  if (a.status === "token") return "free";
  return "anonymous";
}

export function displayName(): string | null {
  const a = auth.value;
  return a.status === "signed_in" ? a.user.name : null;
}

export function setSession(s: HfSession): void {
  auth.value = { status: "signed_in", token: s.token, expiresAt: s.expiresAt, user: s.user };
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ token: s.token, expiresAt: s.expiresAt, user: s.user }));
  } catch {
    /* private window */
  }
}

export function setPastedToken(token: string, remember: boolean): void {
  const clean = token.trim();
  if (!clean) {
    signOut();
    return;
  }
  auth.value = { status: "token", token: clean, remembered: remember };
  try {
    sessionStorage.setItem(TOKEN_KEY, clean);
    if (remember) localStorage.setItem(TOKEN_KEY, clean);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private window */
  }
}

export function signOut(): void {
  auth.value = { status: "anonymous" };
  for (const store of [localStorage, sessionStorage]) {
    try {
      store.removeItem(SESSION_KEY);
      store.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Restore a previous sign-in, finish an OAuth redirect, and drop the v2 habit of keeping
 * a token inside the backend settings blob.
 */
export async function restoreAuth(): Promise<void> {
  forgetLegacyToken();

  if (isConfigured()) {
    try {
      const fresh = await handleRedirectIfPresent();
      if (fresh) {
        setSession(fresh);
        return;
      }
    } catch (e) {
      // Surface nothing here: the caller shows it. Anonymous still works.
      console.warn("sign-in did not complete:", (e as Error).message);
    }
  }

  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw) {
      const s = JSON.parse(raw) as { token: string; expiresAt: number; user: HfUser };
      if (s.token && s.expiresAt > Date.now() + 30_000) {
        auth.value = { status: "signed_in", ...s };
        return;
      }
      localStorage.removeItem(SESSION_KEY);
    }
  } catch {
    /* corrupt or blocked storage: stay anonymous */
  }

  try {
    const pasted = localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);
    if (pasted) auth.value = { status: "token", token: pasted, remembered: Boolean(localStorage.getItem(TOKEN_KEY)) };
  } catch {
    /* ignore */
  }
}

/** v2 stored the HF token inside the backend config blob. Tokens do not belong there. */
function forgetLegacyToken(): void {
  try {
    const raw = localStorage.getItem(LEGACY_BACKEND_KEY);
    if (!raw) return;
    const cfg = JSON.parse(raw) as { baseUrl?: string; token?: string | null };
    if (!cfg.token) return;
    const migrated = cfg.token;
    delete cfg.token;
    localStorage.setItem(LEGACY_BACKEND_KEY, JSON.stringify(cfg));
    sessionStorage.setItem(TOKEN_KEY, migrated);
  } catch {
    /* ignore */
  }
}

/** Re-check a stored session against the Hub; clears it if the token was revoked. */
export async function revalidate(): Promise<void> {
  const a = auth.value;
  if (a.status !== "signed_in") return;
  try {
    const user = await fetchUser(a.token);
    auth.value = { ...a, user };
  } catch {
    signOut();
  }
}
