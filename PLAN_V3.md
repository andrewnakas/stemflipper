# StemFlipper next-gen — a consumer-grade site at audiosaw.com/stemflipper/

## Context

StemFlipper v2 (repo `/Users/nakas/Documents/stemflipper`) is fully built and deployed: the
Hugging Face ZeroGPU Space `nakas/stemflipper` runs the pipeline (hierarchical separation →
per-stem transcription → MIDI + drum kits + multisamples + loops + SFZ/DecentSampler/Vital/
DAWproject) and a Vite + Preact editor at https://andrewnakas.github.io/stemflipper/ plays the
original stems against the synth/sampler reconstruction with note editing and exports. Only
P6 of `PLAN_V2.md` (quota UX, weight preloading, docs) is unchecked.

The user's ask (2026-09-22): **"plan out a next-gen StemFlipper that is extremely easy to use,
is its own website, is super intuitive and works so well."**

What exploration found: the audio engine (`web/src/engine/*`), model ops (`web/src/model/*`)
and export writers (`web/src/export/*`) are solid and stay untouched. The *consumer* layer is
~110 lines inside one 715-line `web/src/ui/App.tsx`:

- Site root is a meta-refresh; no landing page, no demo, no social card.
- The upload form shows a preset dropdown, a "split guitar & piano" checkbox, a raw **backend
  URL field**, an **HF token password field** and a paragraph about GPU quota before the first
  click. No client-side size/duration check (server: ≤ 8 min, ≤ 40 MB).
- No job state machine: `store.status` is a free-text string. `backend.ts` computes a progress
  fraction from the Gradio SSE stream and `App.tsx:235` throws it away. No queue rank/ETA, no
  cancel (AbortSignal plumbed, never used), no resume (session_hash never persisted).
- Errors are raw `Error.message` in 12 px dim text in a top-bar corner.
- The result handler takes only `data[3]` (project.json); **`data[0]`, the bundle zip with
  SFZ/DecentSampler/Vital/loops/phrases/DAWproject, is discarded.** `backend.ts::fileUrl` exists,
  is tested, and is never called. chords/sections/loops/phrases/instrument files have no UI.
- `theme.css` is 69 lines, dark only, zero media queries; layout is mostly inline styles.
- The only reachable demo is an 8-second synthetic bleep (`?fixture=ci`); the good fixture is
  gitignored.
- Tests cover engine/model/wire format; nothing renders a component or walks the upload flow.

## Decisions (user, 2026-09-22)

1. **Compute stays free for the owner.** The ZeroGPU Space remains the backend; visitors spend
   *their own* HF quota (anonymous 2 GPU-min/day, free account 5, PRO 40). The site adds
   **Sign in with Hugging Face** (public PKCE app, no secret) and sends the token as
   `Authorization: Bearer` on the Space's queue calls.
2. **URL:** `https://audiosaw.com/stemflipper/` — a path on the user's existing site
   (Cloudflare Pages, deployed from `main` of private repo `andrewnakas/audiosaw`, no build
   step). GitHub Pages keeps building the app; a Cloudflare Pages Function in the audiosaw
   repo reverse-proxies `/stemflipper/*` to it. Vite `base` stays `/stemflipper/`.
3. **UI scope:** a NEW simple flow (landing → drop → progress → Listen) and the existing editor
   kept as **Studio**, re-skinned, one click away.
4. **Demo:** a real CC0 / CC-BY track, processed once through the real pipeline, committed as a
   static fixture, with attribution.
5. **Cross-link:** a StemFlipper card in audiosaw.com's "Make music" rail, delivered as a PR on
   the audiosaw repo (same PR as the proxy).

## Verified facts that shape the design (checked 2026-09-22)

| Fact | Consequence |
|---|---|
| ZeroGPU daily quota: unauthenticated 2 min, free 5 min, PRO 40 min (+$1/10 min credits), reset 24 h after first use; the gate compares the **requested** `duration` to what is left, the charge is the **effective** runtime. Error wordings seen live: `You have exceeded your GPU quota (59s left vs. 60s requested). Please retry in 0:00:56`, `… Sign-up on Hugging Face to get more quotas or retry in 5:03:25`, `You have exceeded your Pro GPU quota`, `Falling back to IP-based quotas` (bad token), HTTP 429 on join. All arrive as `process_completed` with `success:false`, `output.error`. | `neural.GPU_COST` = fast 4 s/min, balanced 12, best 18, + 15 s fixed, clamped [30, 240]; a 3.5-min song ≈ 30 / 60 / 80 s. Anonymous ≈ 3 fast or 1 balanced song/day; free ≈ 4 balanced. **Preset default depends on sign-in state; the estimate is shown before upload; the error text is parsed into a recovery panel.** |
| **CORS is already fine (verified with `OPTIONS` against the live Space):** preflights with `Access-Control-Request-Headers: authorization` from a foreign origin return 200 with the origin echoed and `allow-headers: authorization` for `/gradio_api/upload`, `/queue/join`, `/queue/data`. | No `app.py` CORS work. The only unverified half is whether an `hf_oauth_` token is attributed to the user's quota. |
| Live `/gradio_api/info`: `/flip(audio, preset, six)` → 4 outputs, `data[0]` = zip FileData with an absolute `url`, `data[3]` = project; `/config`: Gradio 6.19, `sse_v3`, `max_file_size` 41943040. Space `gcTimeout` 172800 s (sleeps after 48 h idle); `runtime.stage` and `sha` readable cross-origin from `https://huggingface.co/api/spaces/nakas/stemflipper`. | `fileUrl(cfg, data[0])` is the zip link. Landing pre-wakes the Space and shows a real status. |
| HF OAuth: any website; public apps + PKCE S256; `redirect_uri` exact match (loopback `http://localhost/…` any port); endpoints `/oauth/authorize`, `/oauth/token`, `/oauth/userinfo`; tokens `hf_oauth_…`, `expires_in` 28800 s, no refresh; scopes `openid profile` suffice. huggingface.js's helpers are ~100 lines but the package is heavy. | Hand-rolled `web/src/api/hfAuth.ts` (~120 lines) with the RFC 7636 test vector. |
| Pipeline progress descs: 0.02 "Loading audio", 0.08 "Separating stems (…) — the slow part", 0.42 "Analyzing tempo, key & chords", 0.45–0.70 "Analyzing & transcribing X", 0.70–0.80 "Building X samples", 0.76 "Reconstructing X effects", 0.90 "Writing MIDI, manifest, DAW projects", 0.96 "Zipping bundle". | Deterministic desc → step mapping for the stepper. |
| audiosaw.com: Cloudflare Pages, `_headers`/`_redirects` (catch-all `/* /404.html 404`), no `functions/` yet, a **root-scoped service worker** (`sw.js`: network-first navigations, cache-first `STATIC_PATHS`, `BYPASS` regex), GA4 `G-5X9ERMVYXE`, brand tokens paper `#fbf6ed` / ink `#1a1814` / amber `#c2410c`, fonts Fraunces + IBM Plex Sans/Mono (OFL) self-hosted. It already has an in-browser `stem-splitter` page. | Pages **Functions run before static assets and `_redirects`**, so `functions/stemflipper/[[path]].js` beats the 404 catch-all; `_routes.json` limits invocations; `sw.js` must bypass `/stemflipper`; `_headers` does not apply to Function responses (set them in the function). StemFlipper adopts the audiosaw tokens and copies the two OFL fonts. Card copy positions it against the in-browser splitter and says it uploads. |
| `fetch` has no upload progress (`XMLHttpRequest` does). Whether Gradio replays a stream after a drop, and the `POST /gradio_api/cancel` shape, are unverified. `preload_from_hub` only mirrors HF-hosted repos; audio-separator and Beat This fetch from GitHub releases. | XHR upload; resume/cancel semantics checked in N0; weight preloading needs the `nakas/stemflipper-weights` mirror (PLAN_V2 P6.2) → recorded as a follow-up, not a gate. |

---

## 1. Target experience

Four screens under hash routes (`#/`, `#/run`, `#/listen`, `#/studio`) so GitHub Pages and the
proxy need no SPA fallback. Deep links stay query params (`?fixture=demo`, `?bundle=…&backend=…`,
OAuth `?code=&state=`).

**Landing (`#/`)** — header "StemFlipper · by AudioSaw" (link home), sign-in chip. Hero:
"Turn any song into stems, MIDI and playable instruments." Primary = drop zone ("Drop a song,
or choose a file · mp3, wav, flac, m4a · up to 8 minutes"; also accepts a bundle `.zip`);
secondary = **Hear an example** (a real song in < 3 s). Below: "what you get" (four cards),
"how it works" (three steps) with the honesty card ("Unlike the rest of AudioSaw, this one
uploads your song to a GPU server on Hugging Face. It is processed there and deleted within
6 hours. Listening, editing and exporting happen in your browser."), a "free, with a daily
limit" table (anonymous / free account / PRO), limits row with links to AudioSaw's Trim and
Convert tools, the demo's attribution, and "Your recent songs" once persistence has entries.

**Run (`#/run`)** — file card (name, duration, size, format) from a client-side preflight;
preset auto-chosen with one line ("Balanced — fits in your free daily GPU time"); **Change**
disclosure = segmented Fast / Balanced / Best with "~N s of GPU" and a quality note each,
presets over budget disabled with the reason; **Advanced** disclosure (split guitar & piano,
backend URL, paste-a-token); one **Flip it** button. Then a stepper with a real bar and
`aria-live`: Uploading (pct) → Waking the engine → In queue (#rank, ~eta) → Loading audio →
Separating → Transcribing → Building samples → Packaging → Loading in your browser (n/total).
Cancel button. Errors render as a panel with one-click recovery (Sign in / Use Fast / wait
with countdown / Trim with AudioSaw / Try the demo / Retry).

**Listen (`#/listen`)** — header: song name, duration, tempo, key, time signature, preset,
"link valid 5 h 12 m" or "saved in this browser" or "Demo · attribution". Shared transport
(play, scrubber, clock). One row per stem: swatch, name, "412 notes · engine", waveform strip,
Solo / Mute / volume, sub-stem chips (kick, snare, …). Chord chips and sections bar; "How this
was made" disclosure (today's StageTrail). **Downloads** card: **Everything (.zip · 48 MB)**,
then Stems (FLAC), MIDI (song, chords, per stem), Instruments (drum kit, SFZ, DecentSampler,
Vital, with "opens in …"), Loops (n), Phrases (n), DAW project, README. **Open in Studio** with
a one-line explainer; "Flip another song"; "Keep in this browser"; "Copy link".

**Studio (`#/studio`)** — today's editor, re-skinned, with "← Listen", a first-run shortcut
sheet (`?` reopens), a lane explainer strip (Original / Synth / Sampler), section names on the
ruler. Below 900 px a "works best on a larger screen" notice; still renders.

---

## 2. Architecture

### 2.1 Hosting and URL (build unchanged)

- GitHub Pages keeps serving `andrewnakas.github.io/stemflipper/` from `pages.yml`; Vite
  `base` stays `/stemflipper/`, so paths are identical behind the proxy.
- audiosaw repo gains `functions/stemflipper/[[path]].js` (fetch
  `https://andrewnakas.github.io/stemflipper/<path><search>`, forward `Accept`/`Range`, strip
  GitHub/Fastly headers, set the same security headers as `_headers`, `cf: {cacheTtl: 300}`),
  `functions/stemflipper/index.js` (301 `/stemflipper` → `/stemflipper/`), and `_routes.json`
  `{"version":1,"include":["/stemflipper","/stemflipper/*"],"exclude":[]}`.
- `sw.js`: add `stemflipper(\/|$)` to `BYPASS`; bump its version string.
- The app sets `<link rel="canonical" href="https://audiosaw.com/stemflipper/">` and, once the
  proxy is verified, redirects `github.io` hosts to the canonical URL keeping `search` + `hash`
  (never on localhost, so CI is unaffected).
- Fonts: copy `ibm-plex-sans-var.woff2` and `fraunces-var.woff2` (OFL) into `web/public/fonts/`.
- `web/index.html` becomes the single entry; `web/app.html` becomes a 3-line shim
  `location.replace("./" + location.search + "#/listen")` so `app.html?fixture=ci` keeps working;
  `vite.config.ts` drops the second Rollup input; `web_smoke.mjs` and `pages.yml` wait-on URL
  move to `index.html`.

### 2.2 Frontend structure (`web/src`)

Engine, model ops and export writers untouched. Additive changes marked ✚.

```
config.ts                  SPACE_ID, DEFAULT_BACKEND, HF_CLIENT_ID (VITE_HF_CLIENT_ID), LIMITS {maxMinutes 8, maxBytes 40 MiB},
                           BUNDLE_TTL_H 6, AUDIOSAW_LINKS {home, trim, convert}
ui/App.tsx                 shell (~80 lines): Header, route switch, Toasts
ui/router.ts               hash router: `route` signal, navigate(), parseHash() (~40 lines)
ui/theme.ts                cssVar() + themeVersion signal (canvases re-read tokens)
ui/components/             Button, Card, ProgressBar, Disclosure, SegmentedControl, Toast, ErrorPanel, Modal, Badge, Kbd, Avatar
ui/landing/                Landing.tsx, DropZone.tsx, WhatYouGet.tsx, HowItWorks.tsx, PricingTable.tsx, Recent.tsx, Attribution.tsx
ui/run/                    RunScreen.tsx, FileCard.tsx, PresetPicker.tsx, AdvancedPanel.tsx, ProgressSteps.tsx
ui/listen/                 ListenScreen.tsx, TransportBar.tsx, StemRow.tsx, Waveform.tsx (peaks from the cached decoded buffers),
                           SongFacts.tsx (chords, sections, stage trail), Downloads.tsx
ui/studio/                 Studio.tsx (Editor + TrackRow + StageTrail moved verbatim), StudioBar.tsx (TopBar's editor half),
                           gestures.ts (App.tsx L562-653), keymap.ts (App.tsx L50-90, active only on #/studio),
                           ShortcutSheet.tsx, LaneExplainer.tsx
ui/account/                SignInButton.tsx, QuotaNote.tsx
ui/exports.ts              downloadMix, downloadBundle, saveBlob (from App.tsx)
model/job.ts               JobPhase union, JobError, JobEvent, pure reduce(), classifyError()
model/jobStore.ts          `job` signal; startJob(file, opts), cancelJob(), resumeJob(); sessionStorage persistence; wake lock
model/preflight.ts         size/format allowlist + duration by header parse (WAV/FLAC/MP3 Xing or CBR/MP4 mvhd, magic-byte sniffed),
                           fallback decodeAudioData for unknown containers < 15 MB
model/quota.ts             GPU_COST/GPU_FIXED_S/GPU_SIX_EXTRA mirror, estimateGpuSeconds, dailyBudgetS(tier), songsPerDay,
                           pickPreset, parseQuotaError (both orderings + retry timers + sign-up + Pro + IP-fallback), recovery()
model/auth.ts              `auth` signal: anonymous | signed_in{token, expiresAt, user{name, picture, isPro}} | token{pasted};
                           effectiveToken(), tier()
model/playback.ts          the `session` singleton + openProject/togglePlay/toggleLoop (out of App.tsx)
model/persist.ts           IndexedDB `stemflipper`: projects {id, name, savedAt, project(edited rows), mixer, attribution?, zipBytes?}
model/zipLoader.ts         openBundleZip(blob) → blob AssetSource (fflate unzipSync; prefix folder handled)
api/hfAuth.ts              loginUrl(), handleRedirectIfPresent(), logout() — PKCE S256, verifier/nonce in sessionStorage
api/space.ts               fetchSpaceStage(), wakePing() — only for *.hf.space backends
api/backend.ts             ✚ joinQueue() (caller owns session_hash, gets event_id), runFlip as wrapper, streamResult(..., onMessage?),
                           uploadFileWithProgress() (XHR), cancelRun() (POST /gradio_api/cancel)
api/assets.ts              ✚ AssetSource kind "blob" {urls}; onAssetProgress() counters inside fetchBytes
export/bundle.ts           ✚ collectBundleFiles(project, source) → client-built zip for static/blob sources
styles/                    tokens.css (audiosaw palette light + dark, spacing, radii, type, focus, --roll-*/--ruler-*),
                           base.css, layout.css (640/900/1200), components.css, studio.css; theme.css = aggregator
```

### 2.3 Job state machine (`model/job.ts`, pure, unit-tested)

```ts
type JobPhase =
  | { kind: "idle" }
  | { kind: "preflight"; file: FileMeta }
  | { kind: "uploading"; file: FileMeta; pct: number }
  | { kind: "waking"; stage: "SLEEPING" | "BUILDING" | "unknown"; since: number }
  | { kind: "queued"; rank: number; size: number; etaS: number | null }
  | { kind: "running"; step: "load" | "separate" | "transcribe" | "samples" | "package"; desc: string; pct: number; startedAt: number; expectedS: number }
  | { kind: "loading"; loaded: number; total: number }
  | { kind: "ready"; result: { project; source; zipUrl; expiresAt } }
  | { kind: "error"; error: JobError };
interface JobError { code: "quota" | "rate_limited" | "too_long" | "too_big" | "undecodable" | "sleeping" | "network" | "cancelled" | "backend" | "auth";
  message: string; requestedS?: number; leftS?: number; retryAfterS?: number;
  recovery: ("sign_in" | "use_fast" | "wait" | "retry" | "trim" | "paste_token" | "demo")[] }
```
Frame mapping: `estimation{rank, queue_size, rank_eta}` → queued; `process_starts` →
running(load); `progress.progress_data[0]{progress, desc}` → running with `step` from the desc
prefix (Separating → separate; Analyzing/transcribing → transcribe; Building/Reconstructing →
samples; Writing/Zipping → package); `process_completed` → ready or error via
`classifyError(output.error)`; `unexpected_error`/`close_stream` → network; `heartbeat` ignored.
`jobStore.startJob`: `resumeAudio()` inside the click → preflight → wake check → XHR upload →
`joinQueue` → `streamResult` → `openProject` (asset counters) → `navigate("#/listen")`.
Persists `sessionStorage["sf.job"] = {sessionHash, eventId, baseUrl, fileRef, preset,
startedAt}` and on ready `sessionStorage["sf.result"] = {bundleRoot, baseUrl, zipUrl,
expiresAt}`; `resumeJob()` re-opens `queue/data` with the same hash (behaviour fixed by N0) or
offers a re-run with the already-uploaded `fileRef`. `navigator.wakeLock` held during a job.

### 2.4 Sign in with HF + quota

- OAuth app (user step, once): https://huggingface.co/settings/applications/new — public
  (no secret), scopes `openid profile`, redirect URIs `https://audiosaw.com/stemflipper/`,
  `https://andrewnakas.github.io/stemflipper/`, `http://localhost/stemflipper/`.
- `hfAuth.ts`: authorize URL with `code_challenge` (S256 via `crypto.subtle`), exchange at
  `/oauth/token` with `client_id + code + redirect_uri + code_verifier`, `/oauth/userinfo`,
  `history.replaceState` to strip `?code&state`.
- Storage: OAuth result in `localStorage["sf.auth"]` (scope openid+profile only, ≤ 8 h expiry,
  cleared on expiry/sign-out; worst case of a leak = someone spends the user's daily GPU
  minutes). Pasted PATs default to `sessionStorage` with a "remember on this device" checkbox.
  `store.ts::saveBackend` stops persisting `token`; the old `stemflipper.backend.token` key is
  deleted on boot. Tokens never appear in URLs, logs or `project.json`.
- `quota.ts`: `pickPreset(durationS, tier)` = pro → best allowed, default balanced; free →
  balanced; anonymous → balanced if the estimate ≤ 100 s else fast. `QuotaNote` copy:
  "Balanced needs ~57 s of GPU for this 3:28 song. Without an account you get about 2 minutes a
  day, charged only for time actually used. Sign in (free) for 5 minutes a day."
- Quota error → ErrorPanel with a countdown from `retryAfterS` and `[Sign in] [Use Fast] [Try
  the demo]`; `auth` errors (`Falling back to IP-based quotas`) → sign out + "sign in again".

### 2.5 Persistence and re-open

"Keep in this browser" fetches the bundle zip once (`fetchBytes(zipUrl)`) and stores the Blob
plus the edited project rows and mixer in IndexedDB; opening a recent entry unzips to blob URLs
(`zipLoader.ts`) → `AssetSource {kind:"blob"}` → `assetUrl` (the engine only ever calls
`assetUrl`, so it is untouched); `URL.revokeObjectURL` on dispose. Dropping a downloaded bundle
zip on the landing takes the same path. Studio edits save into the entry on each history push.
Recent cards show name, date, size (`navigator.storage.estimate()`), open/delete.

### 2.6 Design system

`styles/tokens.css`: audiosaw palette (paper/ink/amber/rule/card, serif/sans/mono, shadows) on
`:root`, dark counterparts under `prefers-color-scheme: dark` and `[data-theme]`; Studio uses
the dark scheme by default (`data-scheme="studio"`); `--roll-*`/`--ruler-*` so `PianoRoll.tsx`
and `Ruler.tsx` read colours through `cssVar()` instead of hard-coded hex. Spacing 4/8/12/16/
24/32, breakpoints 640/900/1200, focus rings, `prefers-reduced-motion`, 44 px touch targets.
Inline layout styles in the moved editor files become classes.

### 2.7 Backend touches (`app.py`, README) — small; Invariants 7–10 untouched

- `EDITOR_URL = "https://audiosaw.com/stemflipper/"`; the Gradio UI's link becomes a real deep
  link `?backend=<space>&bundle=<root>#/listen`.
- `flip()` adds `project["_server"]["expires_utc"]` (now + `WORKDIR_TTL_H`) and `["zip_bytes"]`
  so the UI shows real expiry/size without a HEAD.
- Typed `gr.Error` prefixes (`too_long: …`, `undecodable: …`) for exact client mapping.
- `tests/test_app.py`: assert `/flip` has 4 returns with the zip first → **Invariant #11**.
- README front matter: `preload_from_hub` deferred (needs the weights mirror); README body
  rewritten site-first.

---

## 3. Phases (each independently shippable; the live site never breaks)

| # | Phase | Sessions | Gate |
|---|---|---|---|
| N0 | Spike: OAuth attribution, resume/cancel semantics, frame recording | 0.5 | Decision recorded in HANDOFF; frames saved |
| N1 | Foundation: tokens, router, job machine, Run + Listen screens, Studio moved, mock backend + smoke | 2.5 | Upload → Listen works vs mock in CI and vs the live Space; Studio unchanged |
| N2 | Sign-in, quota panel, preflight, error recovery | 1.5 | Live signed-in run attributed; quota panel; vitest green |
| N3 | Demo fixture, landing content, mobile/Safari pass | 1 | demo ≤ 10 MB committed; `demo` smoke green; iPhone plays |
| N4 | Persistence, zip open, recents | 1 | Reload after "Keep" plays; zip drop opens |
| N5 | Studio re-skin, first-run sheet, lane explainer, canvas theming | 0.75 | `fixture` smoke green in both schemes |
| N6 | Path cutover on audiosaw.com + card PR | 0.5 + user merge | Anonymous + signed-in runs from `audiosaw.com/stemflipper/` |
| N7 | Docs, HANDOFF v3, README, follow-ups | 0.5 | HANDOFF/README current |

### N0 — Spike (0.5 session + user step)
1. User registers the OAuth app (2.4) and gives me the client id.
2. `web/scripts/spike_oauth.mjs` (throwaway, becomes `hfAuth.ts`): PKCE, ephemeral loopback
   port, token exchange, `/oauth/userinfo`.
3. **Deterministic attribution test:** an 8-minute WAV (`ffmpeg -f lavfi -i anoisesrc=d=480`)
   with preset `best` requests `min(15 + 18×8, 240)` = **159 s**, above the anonymous 120 s
   pool and below the free 300 s pool. From the browser (`npm run dev`, existing token field),
   three runs: (a) no token, (b) the `hf_oauth_` token, (c) a fine-grained PAT with no
   permissions. Read `process_completed.output.error`: `120s left` / "Sign-up" = anonymous pool;
   `300s left` (or the job runs; on a PRO account it simply runs) = attributed = **PASS**;
   `Falling back to IP-based quotas` = FAIL for that token type. Using a second free HF account
   makes the pool size unambiguous; the user's own account also works if the run is allowed to
   proceed (costs ≤ 159 GPU-seconds).
4. Also record: DevTools shows `authorization` on all three calls; closing `queue/data` for 30 s
   and reopening with the same `session_hash` → replay or `session_not_found`; `POST
   /gradio_api/cancel {session_hash, fn_index:0, event_id}` accepted?; raw frames of one good run
   via `curl -N` → `web/test/fixtures/gradio_frames.jsonl`; SLEEPING → RUNNING wake time.
5. Decision rule: OAuth passes → build 2.4 as designed. OAuth fails but the PAT passes → retry
   once with scope `inference-api`; still failing → ship **paste-a-token behind Advanced**
   (help link to settings/tokens, "fine-grained, no permissions"), hide sign-in, keep the quota
   panel keyed on "token present". Both fail → anonymous-only quota panel; docs point at
   running the backend locally.
**Gate:** findings + rule outcome written into HANDOFF; `hfAuth.test.ts` green (RFC 7636
vector: verifier `dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk` → challenge
`E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`; state/nonce round trip; expiry).

### N1 — Foundation (2.5 sessions)
- N1a tokens/components/router/`theme.ts`; `index.html` entry + `app.html` shim.
- N1b `job.ts` + `jobStore.ts`; `backend.ts` ✚ (`joinQueue`, `onMessage`, XHR upload,
  `cancelRun`); `space.ts`; `assets.ts` asset counters; `playback.ts`.
- N1c `RunScreen` + `ProgressSteps` + `ErrorPanel`; `ListenScreen` (shared `Session` with
  Studio — one decode, instant "Open in Studio"; synth/sampler bytes are < 10 % of a bundle so
  lazy lanes are deliberately not built), `Downloads` (zip via `fileUrl(data[0])`, everything
  else via `assetUrl`, `collectBundleFiles` for static/blob), Studio moved verbatim into
  `ui/studio/*` with `AdvancedPanel` holding URL + token; Landing v1 with "Hear an example" on
  `?fixture=ci` until N3.
- N1d `web/scripts/mock_backend.mjs`: `/gradio_api/upload`, `/queue/join` → `{event_id}`,
  `/queue/data` replays `gradio_frames.jsonl` with delays, `data[0]={url:…/ci/bundle.zip}`,
  `data[3]` = ci project with `_server.bundle_root="/ci"`, `/gradio_api/file=/ci/<rel>` from
  `public/fixtures/ci`, `MOCK_MODE=quota|sleeping|slow|drop`; `web_smoke.mjs --scenario
  fixture|demo|upload|quota`; `__sf` gains `job`, `jobLog`, `navigate`; `pages.yml` runs all.
**Gate:** vitest `job`, `router`, `errors` green; `upload` + `quota` scenarios green in CI; a
real run from localhost shows upload %, queue rank, stage names and bar; cancel returns to the
file card; `App.tsx` ≤ 120 lines; existing Studio edit/undo/export smoke assertions unchanged.

### N2 — Sign-in, quota, preflight, recovery (1.5 sessions)
- `hfAuth.ts`, `auth.ts`, `quota.ts`, `preflight.ts`, `SignInButton` (avatar menu: name, tier,
  sign out), `QuotaNote`, `PresetPicker` gating, `pickPreset` wiring, token-expiry re-prompt,
  429 auto-retry 5/15/45 s, "too long/too big" panels linking to AudioSaw Trim/Convert.
**Gate:** vitest `quota` (estimate table identical to `neural.estimate_gpu_seconds` for 10/60/
210/480 s × presets × six; all quota wordings parse), `preflight` (synthetic WAV/FLAC/MP3-Xing/
MP4 headers, AAC-named-mp3) green; live: signed-in run attributed per N0; anonymous default
rule observed; expired token → prompt, not a 401.

### N3 — Demo fixture, landing content, mobile/Safari (1 session)
- Track: I shortlist three CC0 (preferred) or CC-BY 4.0 full-band songs with vocals, drums and
  bass, 4/4, 100–130 BPM (Free Music Archive / ccMixter / Wikimedia Commons); user picks one.
- `scripts/make_demo_fixture.py --src song.mp3 --start 61 --seconds 40 --preset balanced`:
  ffmpeg trim with 0.3 s fades → run through the **live Space** with `gradio_client` + owner
  token (parity with production; Python is not bound by Invariant #10) → unzip →
  `validate_project` → strip `_server`, drop `project.dawproject` (2.3 MB) → 16-bit FLAC →
  `attribution.json {title, artist, license, url}` → fail if > 10 MB. `.gitignore` keeps
  `fixtures/song/` ignored, not `demo/`. No LFS (Pages cannot serve it).
- Landing final copy (§1), OG/Twitter meta + social image, favicon set; mobile pass at 375 px;
  iPhone Safari: FLAC `decodeAudioData` verified, else demo stems ship as `.m4a`.
**Gate:** "Hear an example" shows a real song with attribution in < 3 s; `demo` smoke green;
no horizontal scroll at 375/768/1280 (screenshot sweep); iPhone plays after the first tap.

### N4 — Persistence, zip open, recents (1 session)
- `persist.ts`, `zipLoader.ts`, `assets.ts` blob source, "Keep in this browser", DropZone
  accepts `.zip`, `Recent.tsx`, `?open=recent:<id>`.
**Gate:** reload after "Keep" plays the song with its edits; dropping a downloaded bundle opens
it; `zipLoader.test.ts` + `persist.test.ts` (fake-indexeddb) green.

### N5 — Studio re-skin + onboarding (0.75 session)
- Tokens in `PianoRoll.tsx:172-277` and `Ruler.tsx:72-103` via `cssVar()`; `StudioBar` with
  "← Listen", Keep, Export (`stems: true` exposed); `ShortcutSheet` (once, `?` reopens);
  `LaneExplainer`; sections on the ruler; < 900 px notice.
**Gate:** `fixture` smoke green in light and dark; keyboard-only landing → listen → studio
works; Lighthouse a11y ≥ 90 on landing.

### N6 — Path cutover + audiosaw PR (0.5 session + user merge)
1. StemFlipper repo: canonical link; github.io → audiosaw redirect behind a build flag (off);
   `EDITOR_URL`; README links; `finish_deploy.py` liveness URL → new origin; OAuth redirect URIs
   confirmed.
2. audiosaw PR (branch `stemflipper-mount`): `functions/stemflipper/[[path]].js`,
   `functions/stemflipper/index.js`, `_routes.json`, `sw.js` BYPASS + version bump, the "Make
   music" card registered the way `tools/build-nav.js` expects (exactly one rail), then
   `node tools/build-nav.js && node tools/build-sitemap.js && node tools/build-llms.js`.
   Card copy: "StemFlipper — stems, MIDI, drum kits and loops from any song, with an editor.
   Uses a free GPU on Hugging Face, so unlike the tools above this one uploads your file
   (deleted within 6 hours)." Optional: the same GA4 tag on the StemFlipper page.
3. User merges → verify from a real browser: `/stemflipper/` 200 with security headers, hashed
   assets edge-cached, FLAC range requests, OAuth round trip on the new origin, SW bypass (a
   fresh deploy visible on the second visit). Then flip the redirect flag and redeploy the Space.
**Gate:** one anonymous and one signed-in run from `https://audiosaw.com/stemflipper/` succeed;
`github.io/stemflipper/app.html?fixture=ci` lands on the demo.

### N7 — Docs + follow-ups (0.5 session)
- README site-first; `HANDOFF.md` v3 STATUS/queue; invariants **11** (`/flip` output order,
  zip first), **12** (tokens never in URLs/logs/project.json), **13** (an anonymous visitor
  must be able to complete a run on the default preset); re-measure `GPU_COST` from live runs
  (P6.5); follow-up notes: weights mirror + `preload_from_hub`, Space concurrency > 1, Ableton
  `.als`. Update the project memory.

---

## 4. Verification

- **Unit (vitest, every commit):** existing 6 suites + `job` (reducer over recorded frames,
  cancel, resume), `router`, `errors`, `hfAuth`, `quota`, `preflight`, `zipLoader`, `persist`.
- **Smoke (puppeteer, CI):** scenarios `fixture` (today's checks), `demo` (landing → Hear an
  example → Listen: stems rendered, play advances, N download links resolve → Studio → edit/undo/
  export), `upload` (mock backend: `preflight → uploading → queued → running → loading → ready`
  via `__sf.jobLog`), `quota` (ErrorPanel text + Sign-in button); viewport sweep with
  screenshots; zero console errors / failed requests.
- **Live checklist (per gate, recorded in HANDOFF):** anonymous default run (DevTools: no CORS
  errors); signed-in run attributed; quota panel (force with `best` on the 8-min file);
  cancel; reload mid-run → reconnect or honest message; SLEEPING Space → wake status;
  iPhone Safari + Android Chrome: landing → demo → play, file picker accepts audio; both colour
  schemes.
- **Python:** `pytest -m "not slow"` stays green; `test_app.py` gains the output-order test and
  the typed-error prefixes.

## 5. Risks

- **OAuth token not attributed to the user's quota** → N0 deterministic test + fallbacks
  (paste-a-token behind Advanced; anonymous-only). CORS is already verified.
- **Token in browser storage** → openid+profile only, ≤ 8 h, cleared on sign-out; PATs default to
  sessionStorage; Invariant 12.
- **Space asleep after 48 h idle** → pre-wake on landing load, "waking" phase with real status;
  weights preload is a follow-up (needs the HF mirror).
- **Quota is checked inside the GPU call, after upload** → client estimate + preset gating avoid
  wasted uploads; the failure itself costs no GPU.
- **Stream loss on mobile** → wake lock + resume by `session_hash`; if Gradio does not replay,
  the UI says so and offers a re-run with the kept `fileRef`.
- **Path proxy** → Functions free tier 100 k req/day (fine); `_headers` not applied to Function
  responses (set in the function); SW must bypass; edge cache 300 s keeps the double hop cheap.
- **Demo fixture size** → 40 s excerpt, 16-bit FLAC, no dawproject, ≤ 10 MB enforced by the
  script; Safari FLAC decode verified before commit.
- **Safari audio unlock** → `resumeAudio()` inside the click that starts a job or the demo;
  "Tap to play" overlay when the context is suspended.
- **One job at a time on the Space** → queue rank + ETA shown; concurrency revisited after
  measuring CPU contention (follow-up).

## Critical files

- `web/src/ui/App.tsx` (split into shell/router/screens/studio; moved gesture + keymap code keeps
  behaviour byte-for-byte), new `ui/landing/*`, `ui/run/*`, `ui/listen/*`, `ui/studio/*`,
  `ui/account/*`, `ui/components/*`, `ui/router.ts`, `ui/theme.ts`, `ui/exports.ts`
- `web/src/model/job.ts`, `jobStore.ts`, `quota.ts`, `preflight.ts`, `auth.ts`, `playback.ts`,
  `persist.ts`, `zipLoader.ts` (new); `store.ts` (stop persisting tokens)
- `web/src/api/hfAuth.ts`, `space.ts` (new); `backend.ts`, `assets.ts` (additive)
- `web/src/export/bundle.ts` (`collectBundleFiles`), `web/src/styles/*` (replaces `ui/theme.css`)
- `web/index.html`, `web/app.html`, `web/vite.config.ts`, `web/config.ts`
- `web/scripts/web_smoke.mjs`, `web/scripts/mock_backend.mjs`, `web/scripts/spike_oauth.mjs`,
  `web/test/*.test.ts`, `web/test/fixtures/gradio_frames.jsonl`
- `web/public/fixtures/demo/*`, `web/public/fonts/*`, `scripts/make_demo_fixture.py`
- `app.py`, `tests/test_app.py`, `README.md`, `HANDOFF.md`, `.github/workflows/pages.yml`,
  `scripts/finish_deploy.py`
- audiosaw repo: `functions/stemflipper/[[path]].js`, `functions/stemflipper/index.js`,
  `_routes.json`, `sw.js`, the "Make music" rail + nav/sitemap/llms build outputs

## Steps only the user can do

1. Create the HF OAuth app (public, `openid profile`, the three redirect URIs) and hand over the
   client id — before N0. Optionally a second free HF account for the unambiguous pool test.
2. `.venv/bin/hf auth login` before any Space redeploy (N3 demo processing, N6, N7). Note: the
   local `.venv` is gone again and must be recreated (`uv venv --python 3.10 .venv`).
3. Pick the demo track from my shortlist of three (N3).
4. Review and merge the audiosaw PR (N6); Cloudflare Pages deploys it on push.
