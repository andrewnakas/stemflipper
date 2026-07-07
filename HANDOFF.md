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
  extrapolates to a bogus huge decay). **⚠️ NOT YET REDEPLOYED** — M4 fix + M5 both await the
  user's redeploy go-ahead. Next: M6 (dataset scaffold).
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
- [ ] **M6 — Dataset scaffold.** `dataset/`: torchsynth (audio, params) generator + dasp wet/param
      effect pairs; publish generator + seeds (NOT terabytes of audio) as an HF `datasets` repo
      (needs user token). *Gate: `datasets.load_dataset` round trip; deterministic regeneration
      from seeds.*
- [ ] **M7 — Static web frontend.** `web/index.html` + `@gradio/client` against the Space API;
      GitHub Pages-ready. *Gate: static page round trip against the live Space.*

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
