/**
 * Sign in with Hugging Face — authorization code + PKCE, no client secret.
 *
 * Why the site needs this at all: ZeroGPU gives an anonymous caller 2 GPU-minutes a day
 * for the whole shared pool, but 5 to a signed-in free account and 40 to PRO. Sending the
 * visitor's own token means the GPU time is billed to them, and everyone gets more runs
 * than the shared pool could ever provide.
 *
 * Hand-rolled rather than pulling in @huggingface/hub: that package carries the whole
 * upload/repo API for what is ~120 lines of standard OAuth here.
 *
 * Scopes are `openid profile` only — enough to know who is signed in, nothing that can
 * touch their repos. The token expires in 8 hours and there is no refresh token for a
 * public client, so signing in again is one click.
 */

import { HF_CLIENT_ID, HF_SCOPES } from "../config";

const AUTHORIZE = "https://huggingface.co/oauth/authorize";
const TOKEN = "https://huggingface.co/oauth/token";
const USERINFO = "https://huggingface.co/oauth/userinfo";

const VERIFIER_KEY = "sf.oauth.verifier";
const STATE_KEY = "sf.oauth.state";

export interface HfUser {
  name: string;
  picture: string | null;
  isPro: boolean;
  sub: string;
}

export interface HfSession {
  token: string;
  expiresAt: number;
  user: HfUser;
}

export function isConfigured(): boolean {
  return HF_CLIENT_ID.length > 0;
}

/** The redirect target must match one registered on the OAuth app exactly. */
export function redirectUri(): string {
  return location.origin + location.pathname;
}

function randomString(bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return base64url(a);
}

function base64url(bytes: Uint8Array | ArrayBuffer): string {
  const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of a) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(digest);
}

/** Build the authorize URL and remember the PKCE verifier for the exchange. */
export async function beginLogin(): Promise<string> {
  const verifier = randomString(48);
  const state = randomString(16);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);
  const params = new URLSearchParams({
    client_id: HF_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: HF_SCOPES,
    state,
    code_challenge: await challengeFor(verifier),
    code_challenge_method: "S256",
  });
  return `${AUTHORIZE}?${params}`;
}

export async function login(): Promise<void> {
  location.href = await beginLogin();
}

/**
 * Complete the flow if we came back from Hugging Face. Returns null on a normal load.
 * Always strips ?code and ?state from the URL so a refresh cannot replay the exchange.
 */
export async function handleRedirectIfPresent(): Promise<HfSession | null> {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  const state = params.get("state");
  const error = params.get("error");
  if (!code && !error) return null;

  const expected = sessionStorage.getItem(STATE_KEY);
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  cleanUrl(["code", "state", "error", "error_description"]);

  if (error) throw new Error(params.get("error_description") || `Sign-in failed (${error}).`);
  if (!expected || state !== expected) throw new Error("Sign-in could not be verified. Please try again.");
  if (!verifier) throw new Error("Sign-in expired before it finished. Please try again.");

  return exchange(code!, verifier);
}

export async function exchange(code: string, verifier: string): Promise<HfSession> {
  const res = await fetch(TOKEN, {
    method: "POST",
    credentials: "omit",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: HF_CLIENT_ID,
      code,
      redirect_uri: redirectUri(),
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(`Sign-in failed (${res.status}).`);
  const body = (await res.json()) as { access_token: string; expires_in?: number };
  const token = body.access_token;
  const expiresAt = Date.now() + (body.expires_in ?? 28_800) * 1000;
  return { token, expiresAt, user: await fetchUser(token) };
}

export async function fetchUser(token: string): Promise<HfUser> {
  const res = await fetch(USERINFO, { headers: { authorization: `Bearer ${token}` }, credentials: "omit" });
  if (!res.ok) throw new Error(`Could not read your Hugging Face profile (${res.status}).`);
  const u = (await res.json()) as {
    preferred_username?: string;
    name?: string;
    picture?: string;
    sub?: string;
    isPro?: boolean;
    is_pro?: boolean;
  };
  return {
    name: u.preferred_username || u.name || "you",
    picture: u.picture || null,
    isPro: Boolean(u.isPro ?? u.is_pro),
    sub: u.sub || "",
  };
}

function cleanUrl(drop: string[]): void {
  const url = new URL(location.href);
  let changed = false;
  for (const k of drop) if (url.searchParams.has(k)) (url.searchParams.delete(k), (changed = true));
  if (changed) history.replaceState(null, "", url.toString());
}
