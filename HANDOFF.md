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
- [ ] **M3 — Deploy free CPU Space (BLOCKS ON USER: `hf auth login`).** Create Space
      `stemflipper` (sdk: gradio, cpu-basic), push repo, live round trip. README documents the
      ZeroGPU upgrade path (Settings → Hardware; code already compatible). *Gate: public URL
      processes a song end-to-end.*
- [ ] **M4 — Router + analysis upgrades.** PANNs CNN14 (`panns-inference`, MIT) buckets the
      "other" stem; router: polyphonic = >0.2 fraction of note-time overlapping → sampler-phrase;
      mono+synth-like (PANNs bucket + high spectral flatness of sustain) → mark for synth-fit;
      mono+acoustic → sampler. `piano-transcription-inference` for keys-classified stems;
      `htdemucs_6s` behind a flag (piano weak — gate it). Synthetic mono-synth/chord fixtures.
      *Gate: router test matrix passes; `pip install` of new deps verified before adding to
      requirements.txt.*
- [ ] **M5 — Effects + synth-fit (frontier, best-effort, flagged).** EQ match: dasp-pytorch
      (git, PIN A SHA) `auto_eq` + auraloss MultiResolutionSTFT; reverb: blind IR → convolution;
      synth-fit (mono+synth stems only): syntheon (PyPI 0.1.0) warm-start → `.vital` preset in
      bundle, optional CMA-ES refine. ALL wrapped in try/except: any failure flags the stem and
      falls back to the sampler path — the pipeline must never hard-fail here. *Gate: fixture
      lead stem yields a loadable .vital; EQ-matched render decreases auraloss vs target.*
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
