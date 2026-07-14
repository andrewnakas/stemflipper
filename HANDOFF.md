# HANDOFF — StemFlipper build state

> **Onboarding (any model, cold session):** Read this file, then `PLAN.md` (research brief +
> component ground truth), then `research/README.md` (report map + corrections). Do the next
> unchecked task in the queue. Update STATUS before stopping. The refined build plan this queue
> came from is `~/.claude/plans/composed-chasing-simon.md` (also summarized here).

## STATUS (update every session)

- **2026-07-07 (Fable):** M0+M1+M2 complete. Full suite green: 19 tests (18 fast + 1 slow
  real-separation e2e). CLI verified end-to-end on the fixture: tempo 120.19, key A minor,
  4 stems each with MIDI + SFZ, valid RPP/manifest/zip. App round trip via gradio_client OK.
  **Timing reality check:** htdemucs separation of the 16 s fixture took ~5 min on this
  M-series Air (MPS, likely RAM-constrained) vs the report's estimate — expect the free CPU
  Space to be slow per song too; measure and record after deploy. Separation bleed makes the
  "vocals" stem of the instrumental fixture non-silent (56 ghost notes) — expected, handled.
  M3 (deploy) next: `scripts/deploy_space.py` ready, user already HF-logged-in as `nakas`.
- **2026-07-07 (Fable, later):** M3 complete — Space LIVE at
  https://huggingface.co/spaces/nakas/stemflipper. Live fixture round trip: **1.9 min for
  16 s of audio** (≈7× realtime ⇒ expect ~15–25 min for a real 3–4 min song on free CPU;
  ZeroGPU upgrade path in README when the user gets PRO). **Next task: M4** (router + PANNs
  + piano transcription). Redeploy after changes with `.venv/bin/python scripts/deploy_space.py`.
- **2026-07-07 (Opus):** M4 complete + **fixed a live Space transcription outage.** Full fast
  suite green: **31 tests** (was 18; +13 for router/piano/backend). New: `stemflipper/router.py`
  (stem-character router + PANNs CNN14 classifier, all lazy-imported & graceful), ByteDance
  piano transcription in `transcribe.py` (routes on router `is_keys`, falls back to basic-pitch),
  router metadata (`strategy`/`instrument`/`polyphonic`/`synth_like`/`wet`/`router_scores`) now
  in the manifest — this is M5's input contract. Router matrix (offline, no weights needed):
  mono_synth→synth-fit, mono_acoustic→sampler, poly_chord→sampler-phrase. **SPACE BUG FIXED:**
  the live Space silently produced ZERO notes on every stem — `tflite-runtime` ships wheels
  compiled against numpy 1.x and hard-crashes under the Space's numpy 2.2.6 (`_ARRAY_API not
  found`), swallowed by `transcribe_stem`'s except→empty. Fix: requirements.txt now installs
  `onnxruntime` instead of `tflite-runtime`; basic-pitch auto-selects ONNX on Linux (backend
  priority tf>coreml>tflite>onnx). Verified the ONNX backend transcribes locally (24 notes on
  the bass fixture). **PANNs is OFF on the Space by default** (`STEMFLIPPER_PANNS=1` to enable):
  the 340 MB CNN14 download would stall the first request; router degrades to spectral cues.
  **⚠️ NOT YET REDEPLOYED** — awaiting user go-ahead (redeploy would push M4 + the fix live).
- **2026-07-07 (Opus, later):** M5 complete. Full fast suite green: **49 tests** (was 31;
  +18 for effects/synth-fit/pipeline). New: `stemflipper/effects.py` (EQ-match curve +
  blind reverb IR, numpy/scipy only) and `stemflipper/synthfit.py` (mono+synth stem →
  Vital `.vital` warm-start preset, JSON, no frontier dep). Pipeline gained an M5 stage
  (`_run_effects_and_synthfit`) writing `effects/<stem>.json` (+`<stem>_ir.wav` when wet)
  for every pitched stem and `instruments/<stem>/<stem>.vital` for synth-fit stems; manifest
  gained `effects`/`instrument_vital`/`synthfit` fields; app summary table gained Vital+FX
  columns; bundle README documents both. **Gate MET:** fixture lead stem yields a loadable
  `.vital` (valid JSON preset); a match EQ from a tonally-tilted render toward the target
  decreases auraloss MultiResolutionSTFT (`test_eq_match_decreases_auraloss`). **Only one new
  dep: `auraloss` (MIT, pure-torch)** — verified installing clean before touching
  requirements.txt (Invariant #2). dasp-pytorch/syntheon/pedalboard intentionally NOT
  required: the EQ curve and .vital are authored with numpy/scipy+JSON so the stage never
  needs a frontier install and CI stays offline; syntheon is an opt-in refiner (`use_synth=True`).
  Every M5 entry point is try/except-wrapped → falls back to the sampler path (Invariants #4/#7).
  RT60 is gated on the router's `wet` flag (a dry-but-sustained tone's Schroeder slope
  extrapolates to a bogus huge decay).
- **2026-07-07 (Opus, redeploy + M6):** **REDEPLOYED — live transcription outage confirmed
  FIXED.** Pushed M4 tflite→onnxruntime fix + M5 to the Space; rebuilt to RUNNING (~8 min);
  live `gradio_client` fixture round trip via `/flip` returned **140 notes** (song.mid 70 +
  drums.mid 70) — previously ZERO on every stem. Space is healthy and transcribing.
  **M6 complete.** Full fast suite green: **63 tests** (was 49; +14 dataset). New `dataset/`
  package: `synth_gen.py` (deterministic torchsynth `Voice` → (audio,params); 78-param vector),
  `effects_gen.py` (seeded dasp-pytorch chain EQ→comp→distortion → (wet,params); 25-param vector),
  `build.py` (both → `datasets.Dataset` with `synth`/`effects` configs + `publish()` to an HF
  datasets repo + dataset card). **Gate MET:** save/`load_from_disk` round trip identical;
  deterministic regeneration from seeds (synth AND effects) bit-for-bit; torchsynth+dasp+datasets
  verified installing+RUNNING against numpy 2.2/torch 2.12 in an isolated probe venv first
  (Invariant #2). **Two design calls:** (1) torchsynth 1.0.2 imports the
  `pytorch_lightning.core.lightning` path removed in PL 2.x — `synth_gen._install_lightning_shim()`
  aliases it, so no PL pin / no env downgrade. (2) `datasets` 5.x `Audio` feature needs
  `torchcodec`+FFmpeg to encode — avoided by storing audio as raw `float32` array columns +
  `sample_rate` (waveform exact, codec-free, more deterministic). **Dataset deps are in
  `dataset/requirements.txt`, deliberately NOT in the app `requirements.txt`** — the Space never
  installs torchsynth/dasp/PL (Invariants #2/#3; dataset track is independent per PLAN.md).
  **`publish()` NOT yet run** — needs the user's HF token/go-ahead to create the public datasets
  repo. Next: M7 (static web frontend against the live Space).
- **2026-07-07 (Opus, M6 publish + M7):** **ALL MILESTONES M0–M7 COMPLETE.**
  (1) **Dataset PUBLISHED + verified live:** https://huggingface.co/datasets/nakas/stemflipper-dataset
  — `load_dataset(repo,"synth")` (64 rows) and `load_dataset(repo,"effects")` (32 rows) both round
  trip from the Hub; published audio matches deterministic local regen. Card needed a `configs:`
  YAML block or the config names don't resolve (fixed). (2) **M7 static frontend LIVE:**
  https://andrewnakas.github.io/stemflipper/ — repo pushed PUBLIC at
  https://github.com/andrewnakas/stemflipper (whole repo, per user). **Hit + fixed a CORS trap:**
  `@gradio/client` works on localhost but is blocked cross-origin (github.io→hf.space) by an HF
  Space preflight-credentials mismatch; rewrote to drive the Space's REST queue API directly with
  `credentials:"omit"`. Verified in a real browser from the github.io origin (upload 200 + join 200,
  no CORS errors) and the full REST flow end-to-end. See the [[hf-space-cors-credentials-trap]]
  memory. **Reminder for the user: revoke the HF token pasted in chat and rotate it.**
- **2026-07-07 (Opus, real-song bug fixes):** user testing a real song exposed TWO live bugs the
  earlier "outage fixed" claim had MISSED (that claim was wrong — I counted a merged `song.mid`
  total and mistook drum notes for working pitched transcription). (1) **Drums-only transcription:**
  on the Linux Space, `tflite-runtime` is a transitive dep of basic-pitch and its backend priority
  (tf>coreml>tflite>onnx) picked tflite BEFORE onnx → numpy-2 `_ARRAY_API` crash on every pitched
  stem; drums survived (librosa, not basic-pitch). Swapping requirements to onnxruntime was NOT
  enough. **Real fix:** `transcribe_pitched` now passes the explicit `.onnx` model path
  (`build_icassp_2022_model_path(FilenameSuffix.onnx)`) to `predict()`, forcing onnxruntime.
  **Verified live per-instrument:** vocals 53, drums 74, bass 25, other 62 (was drums-only).
  (2) **Web page hung on "Uploading…":** opened the SSE `queue/data` stream BEFORE `queue/join`
  registered the session → Gradio replied `session_not_found`, which the `onmessage` switch didn't
  handle → silent hang. **Fix:** join first, then stream; handle `unexpected_error`/retry; guard
  empty result. Verified live: full upload→join→SSE→progress flow, no session_not_found, errors
  surface instead of hanging. Both redeployed/pushed. **LESSON: always verify Space transcription
  with a per-instrument breakdown, never a merged total.** See [[space-tflite-numpy2-trap]].
- **2026-07-09 (Opus, piano-roll feature):** Added a per-stem **piano-roll of detected notes** to
  the web UI (user request: "make the individual stems represent the detected notes on a MIDI/NLE
  sequence"). `export.write_notes()` writes `notes.json` (per stem `{is_drum, notes:[[pitch,start,
  end,vel]]}`, empty stems omitted); pipeline calls it + records a manifest `notes` ref; `app.py`
  `flip()` appends the notes JSON as the LAST output (`gr.JSON(visible=False)` so existing preview
  indices stay stable); `web/index.html` `makePianoRoll()` draws each stem's notes on a HiDPI canvas
  (pitch Y w/ octave labels, Kick/Snare/Hat lanes for drums, velocity-colored rects). Also fixed the
  stem-preview LABELS (were mislabeled — now match `PREVIEW_STEMS` vocals/drums/bass/other).
  Screenshot-verified with real fixture notes (bass 24, other 32, drums 63). Fast suite 63 green.
  **⚠️ HF POLICY CHANGE:** creating a Gradio Space on free cpu-basic now returns **402 Payment
  Required** (PRO required). `deploy_space.py` broke at `create_repo`; fixed to catch the 402 and
  upload to the existing Space directly (`upload_folder` alone works — the Space is grandfathered).
- **2026-07-09 (Opus, Phase-2 DAWproject):** Added `export.write_dawproject()` — each stem →
  one track in a `project.dawproject` (open DAW-interchange format: Bitwig 5+/Studio One 6.5+/
  Cubase 14+) carrying BOTH its audio clip AND the transcribed MIDI notes inline; stem audio is
  bundled inside the .dawproject zip. XML authored directly (stdlib zipfile + templates) — NO
  dawproject-py dep (git-only, not on PyPI; same offline-CI call as M5). Seconds→beats via tempo,
  drums on GM ch9, velocity 0..1. Pipeline calls it best-effort (RPP is the always-present
  fallback); manifest gains a `dawproject` ref; README documents it. 65 fast tests green (was 63;
  +2 export). Verified integration: real run emits 4 stem tracks + 119 embedded notes + bundled audio.
  Phase-2 items still open: train synth/effect estimators (heavy GPU); ADT drums (blocked — all good
  models are NC-licensed); Ableton `.als` export; WASM/in-browser (deferred, large).
- **2026-07-09 (Opus, playable piano-roll):** Made the web piano-roll INTERACTIVE — each stem gets a
  ▶ Play button that sonifies its notes via WebAudio (sawtooth osc MIDI→freq for pitched; bandpassed
  noise bursts for drums by pitch) with an animated orange playhead (rAF synced to
  AudioContext.currentTime) and the sounding note lit white; one stem at a time, toggle Play/Stop.
  Pure client-side (`web/index.html` only — note data already reaches the page). `makePianoRoll` now
  returns `{canvas, render, dur}`. Browser-verified: Play → "■ Stop" + rAF ~61fps + playhead animates
  + zero console errors; Stop resets. NEXT loop candidates (user picks): Ableton `.als` (risky —
  proprietary), inline-RPP-MIDI (risky — needs Reaper to validate), or web polish/hardening.
- **2026-07-14 (Opus, piano-roll transport):** Reworked the web player around a SHARED TRANSPORT so
  the reconstruction plays as a SONG and is SCRUBBABLE (user: "make the piano roll better UX, a scrub
  wheel, play whatever reconstructed song together"). `web/index.html` only. New: master transport bar
  (▶ Play song / ■ Stop plays EVERY stem's notes at once on one AudioContext timeline; all rolls'
  playheads animate in sync from one rAF loop; per-voice gain 1/sqrt(n) anti-clip), a scrub wheel
  (draggable knob + fill + m:ss clock; dragging any roll canvas also scrubs — seek freezes the
  audio-driven render mid-drag then reschedules from the release point), and per-stem ▶ Solo (plays
  one, mutes rest) + Mute (drops a stem from the mix, live-reschedules). `makePianoRoll` now returns
  `{canvas, render, dur, timeAtX}`; `transport` object owns all playback state. Verified in TWO
  independent real-Chrome drivers (Puppeteer + raw CDP), zero JS errors: clock advances, playheads
  sync across 3 rolls, scrub (bar+canvas) seeks, drag-while-playing resumes, mute 76→36 sources, solo
  btn flips to ■ Stop. 65 fast tests green (no backend change). Pushed to main → Pages redeploys.
  **NOW LOOPING** (user /loop): improve algorithm/detection/synth so it feels like a music-production
  app. Iteration backlog seeded below.
- **2026-07-14 (Opus, loop iter 1 — playback synth):** Rebuilt the piano-roll's WebAudio voices so
  playback sounds like instruments, not buzzers (`web/index.html` only). PITCHED: two ~8-cent-detuned
  saws → a per-note LOWPASS whose cutoff sweeps (bright attack → settle) via an envelope, cutoff+Q
  velocity-mapped (harder = brighter), proper ADSR amp (8ms atk / 60ms dec / 80% sus / release to note
  end). DRUMS: new `transport.playDrum()` synthesizes real voices — KICK = pitch-swept sine body
  150→50 Hz + highpassed noise click; SNARE = bandpassed-noise crack + ~185 Hz triangle ring; HAT =
  short highpassed noise; velocity drives loudness AND decay length. Verified in headless Chrome via
  CDP: solo-drums 67 sources / full-mix 139 / melody 2-osc-per-note, ZERO exceptions; OfflineAudioContext
  render of a loud kick → peak 1.14, early energy 242.8 ≫ late 0.45 (punchy, decays). 65 fast tests
  green. NEXT backlog (from survey, ranked): [detection] snap notes to tempo grid (beat_times already
  computed in analyze.py, unused for quantization — biggest "feels like a DAW" win); dedup/merge stutter
  notes; velocity median-smoothing; [drums] lower onset delta 0.05→0.03 + velocity gate; [synthfit]
  clamp attack ≤80ms. Backend changes need `pytest -m "not slow"` green + a match-rate non-regression.
- **2026-07-14 (Opus, loop iter 2 — tempo-grid quantization):** New `stemflipper/quantize.py` snaps
  transcribed note ONSETS to a subdivided beat grid (16th by default) so exported MIDI/DAWproject +
  the piano-roll read tight, not jittery. Pipeline calls `quantize.quantize_notes(notes, beat_times,
  duration)` per stem right after transcription (best-effort try/except, Invariant #7). KEY DESIGN:
  the grid is de-lagged — `_phase_offset()` removes librosa's systematic beat-tracker lag (~10-30 ms)
  by shifting the grid by the circular-median residual of the notes themselves, so we snap out random
  jitter WITHOUT adding the tracker's constant offset to already-tight notes. Tolerance leaves
  genuinely off-grid notes alone; durations preserved (start+end shift together); min-len + past-end
  clamps. **Verification caught a real bug:** first pass (no phase correction) made the fixture bass
  WORSE (grid error 13.7→23.6 ms) because the beat grid started 10-23 ms late; phase correction flipped
  it to a clear win — on real fixture bass, onset JITTER halved (10.1→5.5 ms) and inter-onset gaps
  landing on 16th-note multiples went 22%→96%. Tests: `tests/test_quantize.py` (9 cases incl. the
  systematic-lag scenario). **74 fast tests green** (was 65; +9). Pushed to main. **DEPLOYED LIVE** —
  user chose "deploy now"; `deploy_space.py` uploaded (create_repo still 402/PRO, uploads direct),
  Space rebuilt to RUNNING in ~90 s (Python-only change, cached deps). Quantization now live.
- **2026-07-14 (Opus, loop iter 3 — note cleanup):** New `stemflipper/cleanup.py` runs a pre-quantize
  cleanup chain per stem: `dedup_notes` (collapse same-pitch onsets within 45 ms → one, keep louder
  vel + later end), `merge_stutter` (join same-pitch notes with <60 ms gaps → one held note),
  `smooth_velocity` (rolling median over same-pitch runs). Pipeline calls `cleanup.clean_notes()`
  BEFORE `quantize.quantize_notes()` (both best-effort try/except). Fail-safe: cleans artifacts without
  touching clean input — on the synthetic fixture, note counts held (bass 24→24, drums 63→63, correct:
  no artifacts to remove) while velocity jitter dropped (bass 0.7→0.3, drums 3.0→2.2); the dedup/merge
  paths are covered by `tests/test_cleanup.py` against synthetic ghosts/stutter. **83 fast tests green**
  (was 74; +9). USER PREF GOING FORWARD: batch Space redeploys (approved "deploy now" for iter 2, batch
  future). iter 3 pushed to main; Space redeploy batched with the next backend iter.
- **2026-07-14 (Opus, loop iter 4 — mix bus: reverb + compressor):** Made the whole-song playback sound
  cohesive/produced (`web/index.html`, client-only → Pages, no Space rebuild). New master chain in
  `transport.start()`: sum → gain(0.3) → DynamicsCompressor (thr -14, ratio 3, 4ms atk / 180ms rel) →
  destination, with a parallel reverb SEND (gain 0.14 → ConvolverNode). `transport.reverbIR()` builds a
  cached synthetic 1.6 s decaying-noise stereo IR (no external asset — CSP-safe). The compressor glues
  the mix and is a smarter clip guard than the raw 1/sqrt(n) attenuation. `stopAudio()` tears down the
  new `_chain` nodes. Verified in real Chrome (CDP), zero exceptions: during play `_chain`=3 nodes +
  139 sources; after stop chain/master null (no leak); OfflineAudioContext render of one note → peak
  0.315 (no clip) with reverb TAIL energy 0.07 persisting 0.5-1.5 s AFTER the note ends (send works);
  IR is 2-channel + decaying. **REJECTED iter-4-as-planned (drum onset tuning):** investigated the
  survey's delta 0.05→0.03 + velocity-gate idea — measured it on the fixture AND a synthetic soft-hat
  signal; it detected ZERO extra hats (librosa onset_detect isn't the bottleneck) and the gate only
  removed notes; a centroid hat-classifier tiebreak fixed hats (0.50→0.75) but destroyed snares
  (1.00→0.00). Net: no verifiable improvement → not shipped (honest-verification principle; drums are a
  documented weakness, real fix is an ADT model blocked on NC licensing). 83 fast tests still green
  (no backend change this iter). iter 4 pushed to main (Pages).
- How to run tests: `.venv/bin/pytest -m "not slow"` (fast) · `.venv/bin/pytest -m slow`
  (runs real htdemucs separation on the 14 s fixture, downloads weights on first run).
- How to run the pipeline: `.venv/bin/python -m stemflipper <audio> -o <outdir>`.

## TASK QUEUE

- [x] **M0 — Scaffold.** git init; PLAN.md + research/ copied; venv py3.10; MVP deps install +
      import smoke test; pytest wired; `tests/make_fixture.py` generates the deterministic
      mini-song; HANDOFF.md exists. *Gate: `pytest -k fixture` green; first commit.*
- [x] **M1 — Core pipeline + CLI.** Modules `stemflipper/{audio_io,analyze,separate,transcribe,
      sampler,export,pipeline,__main__}.py`. Flow: load → tempo/key → htdemucs 4-stem
      (audio-separator, model configurable) → per-stem basic-pitch (bass fmin/fmax clamp;
      drums = librosa onset + spectral heuristic → GM 36/38/42) → MIDI-boundary slicing → SFZ
      per stem → bundle `{stems/, midi/, instruments/, manifest.json, README.txt, project.RPP}`
      + zip. *Gate: CLI produces complete bundle on fixture mix; unit tests: ≥80% pitch match on
      clean bass/lead stems, tempo ±2 BPM, SFZ has regions, RPP block-balanced, manifest valid;
      slow e2e passes.*
- [x] **M2 — Gradio `app.py`.** Upload (max_file_size 30 MB, cap ~8 min audio), `gr.Progress`
      stages, stem previews + zip download, queue on, `spaces` import guarded (`@spaces.GPU`
      only wraps the separation call; no-op locally / on CPU Space). *Gate: `gradio_client`
      round trip on fixture returns a valid zip.*
- [x] **M3 — Deploy free CPU Space.** LIVE at https://huggingface.co/spaces/nakas/stemflipper
      (gate passed: fixture round trip via gradio_client in 1.9 min, valid bundle).
      NOTE: deploy uploads RUNTIME FILES ONLY (`scripts/deploy_space.py` allow-list: app.py,
      stemflipper/, requirements.txt, packages.txt, README.md) — internal docs (PLAN.md,
      HANDOFF.md, research/, tests/) stay out of the public Space. To free cpu-basic quota the
      user had me pause their Spaces: timberlineWeatherData, Deep-nowcast, DWD_Icon_Forcast
      (reversible in each Space's settings; free limit ≈ 2 concurrent running Spaces).
- [x] **M4 — Router + analysis upgrades.** DONE. `stemflipper/router.py`: PANNs CNN14 classifier
      + stem-character router (polyphony via chroma concurrency — robust to basic-pitch octave
      ghosts, cross-checked with note-overlap; synth-vs-acoustic via PANNs bucket → spectral
      sustain/flatness fallback; dry/wet informational). Strategy per stem: sampler-phrase (poly) /
      synth-fit (mono+synth) / sampler (mono+acoustic); drums bypass to sampler; bass forced mono.
      ByteDance `transcribe_piano` in transcribe.py (router `is_keys` gate → basic-pitch fallback).
      htdemucs_6s piano/guitar stems flagged `low_confidence` in manifest. Router metadata in
      manifest + app summary table. *Gate MET: router matrix passes offline (31 tests green);
      panns-inference 0.1.1 + piano-transcription-inference 0.0.6 verified installing clean,
      numpy-2 compatible, before touching requirements.txt.* NOTE: also fixed the Space's
      tflite/numpy-2 transcription crash — see STATUS.
- [x] **M5 — Effects + synth-fit (frontier, best-effort, flagged).** DONE. `stemflipper/effects.py`:
      EQ match (`match_eq` corrective curve + `fit_eq` tonal curve, numpy/scipy) + blind reverb
      IR (`estimate_rt60` via release-tail Schroeder slope, gated on router `wet`; `synth_ir`
      decaying-noise IR). `stemflipper/synthfit.py`: mono+synth stems → Vital `.vital` warm-start
      preset (JSON authored from measured pitch/brightness/envelope; syntheon opt-in refiner behind
      `use_synth=True`). Pipeline M5 stage writes `effects/<stem>.json` (+ `_ir.wav` when wet) and
      `instruments/<stem>/<stem>.vital`; manifest + app table + bundle README updated. ALL stages
      try/except → sampler-path fallback (never hard-fails). **Gate MET:** fixture lead yields a
      loadable .vital; match-EQ render decreases auraloss vs target (49 tests green). Decided
      AGAINST hard-requiring dasp-pytorch/syntheon/pedalboard — only `auraloss` (MIT) added,
      verified clean (Invariant #2); the rest are numpy/scipy+JSON so CI stays offline.
- [x] **M6 — Dataset scaffold.** DONE. `dataset/`: `synth_gen.py` (deterministic torchsynth
      `Voice` → (audio, 78-params), PL2 compat shim), `effects_gen.py` (seeded dasp chain
      EQ→comp→distortion → (wet, 25-params)), `build.py` (both → `datasets.Dataset` `synth`/
      `effects` configs + `publish()` to HF datasets repo + card). Audio stored as raw float32
      arrays (avoids `datasets` 5.x `Audio`→torchcodec/FFmpeg dep). Deps in
      `dataset/requirements.txt`, kept OUT of app `requirements.txt` (Space never installs them).
      **Gate MET:** `load_from_disk` round trip identical + deterministic regen from seeds (synth
      + effects), 63 tests green. **PUBLISHED + verified live** at
      https://huggingface.co/datasets/nakas/stemflipper-dataset — `load_dataset(repo,"synth")`
      and `load_dataset(repo,"effects")` both round trip from the Hub, published audio matches
      deterministic local regen (`np.allclose`). Card needed a `configs:` YAML block for the
      config names to resolve (push_to_hub writes synth/ & effects/ dirs but our overwritten
      README dropped the mapping) — fixed in `_dataset_card` (commit 8031d63).
- [x] **M7 — Static web frontend.** DONE + LIVE + cross-origin verified. `web/index.html`:
      build-step-free static client that drives the Space's REST **queue API directly** (sse_v3:
      `POST /gradio_api/upload` → `POST /gradio_api/queue/join` fn_index 0 → SSE `/queue/data`),
      uploading a song and rendering the returned [zip, summary, 4 stem previews]. Root
      `index.html` redirects to `/web`; `.nojekyll` present.
      **⚠️ CORS TRAP (found + fixed this session):** first pass used `@gradio/client` — it works on
      localhost but a REAL cross-origin browser call from github.io→hf.space is BLOCKED, because
      the client fetches with `credentials:"include"` and HF Spaces' CORS omits
      `Access-Control-Allow-Credentials` on the **preflight** response (only the actual GET has it),
      so the preflight fails → `Client.connect` throws "Failed to fetch". The local browser test
      MISSED this (localhost is a trusted origin); the live cross-origin test caught it. Fix:
      dropped `@gradio/client` entirely and call the REST queue API with plain fetch + EventSource
      and `credentials:"omit"`, which the Space's CORS DOES allow. **Verified in a real browser from
      the github.io origin: UPLOAD 200 + JOIN 200 (event_id), no CORS errors**; and the full REST
      flow end-to-end (upload→join→SSE `process_completed`, success, 6 outputs incl. a real `/file=`
      zip URL). **Repo PUBLIC:** https://github.com/andrewnakas/stemflipper (whole repo, per user).
      **Pages LIVE:** https://andrewnakas.github.io/stemflipper/ (main branch, root). *Gate MET:
      live static page reaches the live Space cross-origin and drives /flip.*
      **ALL MILESTONES M0–M7 COMPLETE.**

## INVARIANTS (do not violate)

1. Tests stay green: run `.venv/bin/pytest -m "not slow"` before every commit.
2. Dependencies stay staged: never add a frontier dep to `requirements.txt` without verifying it
   installs cleanly (in the venv) first. numpy/numba/librosa triangle: librosa 0.11 needs
   numba≥0.61 for numpy≥2.1.
3. Licensing: no GPL in anything distributed as a binary (pedalboard GPLv3 = server-side only);
   no NC-licensed weights (ADTOF, LarsNet, umxl stay OUT) beyond the documented
   MUSDB18-trained-separation-weights risk (research/demo framing, see PLAN.md "Licensing").
4. Frontier stages (synth-fit, effects) always degrade gracefully to the sampler path.
5. Python 3.10 pin (basic-pitch ≤3.11 ∩ ZeroGPU {3.10.13, 3.12.12} ∩ Apple Silicon).
6. One commit per completed task; state the gate result in the commit message.
7. The Space must never hard-fail on a stem that is silent, unpitched, or untranscribable —
   empty MIDI/instrument outputs are acceptable, crashes are not.

## LOCAL-MACHINE NOTES

- 2026-07-07: Homebrew ffmpeg was broken (linked stale libx265.215.dylib after an x265
  upgrade); fixed via `brew upgrade ffmpeg` → 8.1.2. audio-separator hard-fails at init if
  `ffmpeg -version` dies — recheck this first if separation errors reappear.
- htdemucs weights (~84 MB) download from dl.fbaipublicfiles.com very slowly on this
  network; cached afterward at `~/.cache/stemflipper/models`.
- HF auth: already logged in as `nakas` (token at ~/.cache/huggingface/token).

## KEY IMPLEMENTATION FACTS (mined from research/, saves re-reading)

- audio-separator: `Separator(model_file_dir=..., output_dir=...)`, `load_model(model_filename=...)`,
  `.separate(path)` → output files. Demucs models auto-download. Run
  `audio-separator --list_models` (or read the package model manifest) to confirm exact model
  filenames at runtime — don't hardcode blindly.
- basic-pitch: `from basic_pitch.inference import predict` → `(model_output, midi_data,
  note_events)`; tunables `onset_threshold, frame_threshold, minimum_note_length,
  minimum_frequency, maximum_frequency`. Bass: clamp ~30–350 Hz to kill octave errors.
- Drums GM map: kick→36, snare→38, closed hat→42 (open 46), channel 10 (index 9),
  `pretty_midi.Instrument(program=0, is_drum=True)`.
- SFZ opcodes for slices: `sample, lokey/hikey, pitch_keycenter, lovel/hivel, loop_mode
  (one_shot for decaying), ampeg_release`. Plain text; no library.
- RPP: plain-text `<REAPER_PROJECT ... TEMPO ... <TRACK <ITEM POSITION/LENGTH <SOURCE WAVE
  FILE "...">>>>`. MVP = tempo + audio tracks only; inline MIDI embedding (HASDATA/E hex lines)
  is a later task.
- ZeroGPU pattern (for the future upgrade): load models module-level on CPU, `.to("cuda")`
  INSIDE the `@spaces.GPU(duration=...)` function; only separation gets the decorator; never
  download weights inside it; no torch.compile; Gradio queue stays on.
