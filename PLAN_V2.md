# StemFlipper v2 — best-in-class song → stems → MIDI + samples → in-browser hybrid mixer

## Context

StemFlipper today (repo `/Users/nakas/Documents/stemflipper`, live at
https://andrewnakas.github.io/stemflipper/ + HF Space `nakas/stemflipper`) is an MVP: upload
a song → htdemucs 4-stem separation → basic-pitch / onset-heuristic transcription → one
slice per pitch → SFZ → zip with a thin Reaper `.RPP`. The web page is one 1,141-line static
HTML file whose piano-roll playback is a synth toy: the separated stems are plain
`<audio>` tags that never touch the WebAudio transport, notes are read-only, and only four
hardcoded stems are shown.

The user wants a **redo**: best-in-class at every stage, "upload any song and it fully builds
out MIDI stems and samples", **mix the generated (synth/sampler) stems with the source-separated
stems** on one transport, and **export MIDI + samples + instruments instead of a Reaper project**.

**Decisions locked with the user (2026-09-06):**
- Compute: **ZeroGPU Space** (already switched: Space hardware is `zero-a10g`, RUNNING). Code
  stays CPU-fallback-safe for tests/local (the user's Mac has MPS for local runs).
- Frontend: **Vite + TypeScript rewrite** of `web/`, deployed by a GitHub Actions Pages workflow.
- Exports replacing `.RPP`: multitrack + per-stem **MIDI**; **samples** (drum one-shots, pitched
  multisamples, bar loops, vocal phrases) as WAV; **instruments** SFZ + DecentSampler + Vital;
  keep **DAWproject** (open). Ableton `.als` = proprietary → follow-up only.
- **Full in-browser note editing** (move/resize/draw/erase, velocity, quantise, undo/redo) feeding
  playback and client-side exports.

Execution model: Fable wrote this plan; Opus executes phase by phase (often unattended) from
`HANDOFF.md`, which must be updated at every stop. Each phase is independently shippable.

## Verified facts that shape the design (checked 2026-09-06)

| Fact | Consequence |
|---|---|
| ZeroGPU quotas: anonymous **2 min/day**, free acct 5, PRO 40; API callers are anonymous unless they send `Authorization: Bearer <hf_token>`; torch ≥ 2.8, Python 3.10.13/3.12.12, Gradio SDK only, no `torch.compile`; `duration=` accepts a callable; models on cuda at import (emulation) | **One `@spaces.GPU` call per song** with a dynamic `duration`; GPU budget ≤ 90 s "best" / ≤ 20 s "fast"; frontend gets an optional HF-token field + a **local backend URL** mode (`python app.py` on the Mac) |
| audio-separator (latest 0.47.0; repo pins <0.45) registry has **no 4-stem RoFormer**; it has single-target RoFormers (vocals: `mel_band_roformer_kim_ft2_bleedless_unwa.ckpt`, `bs_roformer_vocals_revive_v3e_unwa.ckpt`, `mel_band_roformer_vocals_fv7b_gabox.ckpt`) and **`MDX23C-DrumSep-aufr33-jarredou.ckpt`** (kick/snare/toms/hh/ride/crash); Demucs v4 `htdemucs(.yaml)`, `htdemucs_ft`, `htdemucs_6s` built in. `Separator.list_supported_model_files()` needs network; `separate(path, custom_output_names={...})` fixes output names | "Best" separation = **hierarchical ensemble**: RoFormer vocals → htdemucs(_ft) on the instrumental → DrumSep on drums. Per-piece drum stems are what make real drum transcription + one-shot kits possible without NC-licensed ADT models. Engines resolve models by friendly-name regex with a static fallback table |
| `beat-this` 1.1.0 (PyPI, **MIT** code+weights; `Audio2Beats(checkpoint_path="final0", device, dbn=False)(y, sr) -> (beats, downbeats)`; madmom NOT needed) | Real bar lines / time-signature inference / loop slicing at downbeats; librosa fallback |
| RMVPE: MIT; `mirbox` pkg NOT on PyPI; reliable source = RVC `infer/rmvpe.py` (MIT, ~650 lines), weights `lj1995/VoiceConversionWebUI/rmvpe.pt` on HF | Vendor the model file for vocal melody f0; pyin fallback. Bass: pyin + basic-pitch cross-check |
| `sfzlint` 0.1.4 (MIT), `pyloudnorm` 0.2.0 on PyPI; npm: vite 8, vitest 5, preact 10.29, @preact/signals 2.11, fflate 0.8, midi-file 1.2 | SFZ validated in CI; LUFS metadata; small frontend stack |
| Blocked by license (Invariant #3): ADTOF, LarsNet, madmom models, umxl (NC); YourMT3+, crepe-notes, pedalboard-in-binary, PyFLP (GPL) | Not used |
| **No `.venv` exists locally**; Homebrew python3.10/3.12 + `uv` present; `hf` CLI + token absent; Node 26 / npm 11; `gh` authed as andrewnakas; Pages = legacy (main, root); no `.github/workflows` | P0 recreates env, user runs `hf auth login`, adds workflows, switches Pages to workflow builds |
| Browsers decode FLAC via `decodeAudioData`; Python stays **3.10** (basic-pitch ≥3.11 on Linux drags TF; ONNX forcing in `transcribe._onnx_model_path` must survive) | Bundle stems as 24-bit FLAC (≈50 % smaller), samples/loops as 24-bit WAV |
| `scripts/deploy_space.py` allow-list is a FLAT glob `stemflipper/*.py` | Must become recursive once `stemflipper/` gains subpackages |

## Invariants (carried from HANDOFF.md + new)
1. `pytest -m "not slow"` green before every commit (98 fast today; grows to ~150).
2. Verify a new dep installs in the venv before touching `requirements.txt`.
3. No GPL in distributed binaries; no NC weights; research/demo licensing framing stays.
4. Frontier stages degrade gracefully; a silent/unpitched stem never crashes the Space.
5. Python 3.10 pin. 6. One commit per task, gate result in the message.
7. Every stage records `{name, status ok|fallback|skipped|failed, seconds, detail}` into
   `project.json["stages"]` — no more silent `except: pass` without a trace.
8. `project.json` (schema_version 2) is THE contract between backend and frontend.
9. Exactly one `@spaces.GPU` call per song (`neural.run_neural_stage`).
10. Frontend never uses `@gradio/client`; all requests `credentials:"omit"`.

---

## 1. Target architecture

### 1.1 Backend (`stemflipper/`) — stable modules stay flat; facades keep old import paths (tests)

```
stemflipper/
  __init__.py                 version "2.0.0"
  __main__.py                 CLI: --preset fast|balanced|best --six --workers N --no-zip --model-dir (--model kept as alias)
  audio_io.py                 KEEP + write_flac(path,y,sr,bits=24), write_wav24(), trim_to_len()
  analyze.py                  KEEP estimate_key/Analysis(+downbeats, tempo_map, grid_source, key_confidence); analyze_audio delegates to analysis/
  analysis/beats.py           beat_this_beats(y,sr,device)->(beats,downbeats)|None  (lazy Audio2Beats cache) → fallback analyze.estimate_tempo
  analysis/grid.py            Grid dataclass; build_grid(); infer_time_signature(); tempo_map_from_beats(); seconds_to_beats()/beats_to_seconds() (piecewise-linear)
  analysis/chords.py          estimate_chords(y,sr,beats,key): per-beat chroma templates + Viterbi (numpy)
  analysis/sections.py        optional self-similarity novelty → boundaries at downbeats (best-effort)
  separation/__init__.py      PRESETS {fast,balanced,best}, separate_hierarchical()
  separation/registry.py      ModelSpec(key, patterns, static_fallback, group); resolve(spec) via list_supported_model_files() → offline fallback
  separation/engines.py       run_model(input,out_dir,model_filename,model_dir,output_names) (generalised separate.separate_stems; per-model Separator cache)
  separation/hierarchical.py  chain logic, residual folding, sum-to-mix consistency, provenance
  separate.py                 KEEP (KNOWN_STEMS, MODELS, DEFAULT_MODEL, default_model_dir, separate_stems, _stem_name_from_filename)
  neural.py                   NeuralOutputs dataclass; run_neural_stage(input_path, workdir, preset, opts) — THE function app.py wraps with @spaces.GPU; CPU/MPS-safe; GPU_COST table; preload()
  router.py                   KEEP
  transcribe.py               FACADE re-exporting transcription/* (tests monkeypatch transcribe.transcribe_piano — facade-level call keeps that working)
  transcription/basic_pitch.py  transcribe_pitched moved; per-stem THRESHOLDS table; keep _onnx_model_path
  transcription/piano.py        transcribe_piano + _get_piano_transcriptor(device)
  transcription/mono_pitch.py   pyin_f0(), rmvpe_f0() (vendored), f0_to_notes()
  transcription/_rmvpe_model.py vendored RVC rmvpe.py (MIT header kept; repo-local imports stripped)
  transcription/drums.py        transcribe_drums (legacy heuristic, kept) + transcribe_drums_hier(sub_stems)
  transcription/policy.py       transcribe_track(...) engine choice per stem, agreement checks, per-note confidence
  cleanup.py / quantize.py    KEEP
  samples/hits.py             isolate_hits, trim_hit, zero_cross_snap, fade, normalize_peak, dedupe
  samples/drumkit.py          velocity layers + round-robins → kit.json + wavs
  samples/multisample.py      pitched multisample selection, pitch verify, loop detection → instrument.json
  samples/loops.py            bar-aligned loop extraction
  samples/phrases.py          vocal phrase chopper
  samples/writers/sfz.py      (from sampler._render_sfz) layers, RR, loops, ampeg
  samples/writers/dspreset.py DecentSampler XML
  samples/writers/instrument_json.py  browser sampler contract
  sampler.py                  FACADE: build_sampler() legacy single-layer mode (tests/test_sampler.py)
  synthfit.py                 KEEP + build_patch(), render_patch() (numpy subtractive), search_patch() (coarse grid), write_patch(); .vital derived from patch
  effects.py                  KEEP + curve_to_bands(); match_eq wired when a patch render exists
  export/__init__.py          re-exports (keeps `from stemflipper import export` working)
  export/midi.py              mido SMF-1: tempo map, time sig, section markers, chord track; per-stem mids
  export/dawproject.py        write_dawproject moved verbatim
  export/project_json.py      build_project(), validate_project(), from_v1() shim
  export/readme.py            bundle README.txt (no RPP)
  export/bundle.py            write_bundle(): stems→FLAC 24-bit, samples/loops→WAV 24-bit, zip_bundle
  pipeline.py                 Stage runner (status/timing), thread pool per stem, run_pipeline(new signature)
```
Deleted: `export.write_rpp`/`_RPP_TRACK`, `tests/test_export.py::test_rpp_block_balanced`,
`project.RPP` assertion in `tests/test_pipeline.py::_assert_complete_bundle`.

### 1.2 Frontend (`web/`, Vite + TS + Preact + signals; canvas for timeline/rolls)

```
web/ package.json  vite.config.ts (base "/stemflipper/")  tsconfig.json  index.html (the app)
  public/legacy/index.html        current page verbatim (served at /legacy/ until first joint deploy, end of P4)
  public/fixtures/song/           project.json + assets from scripts/make_web_fixture.py (dev/test without a backend)
  src/main.tsx
  src/api/backend.ts              BackendConfig{baseUrl, token}; uploadFile, joinQueue, streamResult (fetch-streamed SSE so an Authorization header is possible), cancel, fileUrl — ported from web/index.html:254-353
  src/api/assets.ts               assetUrl(project, rel); fetchBytes (LRU); decodeAudio(ctx, bytes, {mono})
  src/api/quota.ts                ZeroGPU quota error → {retryAfterS, needsToken}
  src/model/types.ts              Project/Track/Note{id,pitch,start,end,vel,conf}/Lane/Grid (mirrors §1.3)
  src/model/store.ts              signals: project, tracks (lane gains original/synth/sampler, M/S/pan/vol, fx on), transport, viewport{pxPerSec,scrollX}, selection, history
  src/model/commands.ts           Command + History (undo/redo, coalescing)
  src/model/notes.ts              pure ops: move/resize/add/delete/velocity/quantize/select
  src/model/grid.ts               secondsToBeats/beatsToSeconds, snap(), bars:beats formatting
  src/model/persist.ts            IndexedDB: project + edits + mixer (+ optional asset bytes)
  src/engine/context.ts           AudioContext lifecycle (gesture-gated resume; Safari)
  src/engine/graph.ts             buildGraph(ctx: BaseAudioContext, project, mixer) → persistent per-track nodes + master
  src/engine/transport.ts         Clock + 25 ms look-ahead scheduler + loop + seek (§3.5)
  src/engine/lanes/audioLane.ts   decoded stem playback (AudioBufferSourceNode start(when, offset))
  src/engine/lanes/synthLane.ts   poly subtractive synth from patch.json; fallback = today's voice (web/index.html scheduleStem/playDrum)
  src/engine/lanes/samplerLane.ts kit.json / instrument.json player: layers, RR, loop points, playbackRate pitch
  src/engine/fx.ts                EQ biquads from effects.eq.bands; reverb send (IR asset or synthetic makeIR port)
  src/engine/meters.ts  src/engine/render.ts (OfflineAudioContext, track or mix)  src/engine/peaks.ts
  src/ui/App.tsx UploadPanel SettingsPanel StageStatus Timeline Ruler TrackHeader MixerStrip WaveformLane PianoRoll VelocityLane ChordLane TransportBar ExportPanel keymap.ts
  src/export/midi.ts (SMF-1 writer) wav.ts (16/24-bit; port of audioBufferToWav) zip.ts (fflate) bundle.ts
  test/ (vitest)   scripts/web_smoke.mjs (puppeteer headless smoke)
.github/workflows/pages.yml  python.yml
```

### 1.3 `project.json` — the contract (written by `export/project_json.py`, typed in `web/src/model/types.ts`)

Bundle-relative POSIX paths. Note rows `[pitch, start_s, end_s, velocity, confidence]`.

```jsonc
{
  "schema_version": 2,
  "app": {"name": "stemflipper", "version": "2.0.0", "created_utc": "..."},
  "song": {"source_file": "song.mp3", "duration": 212.4, "sample_rate": 44100, "channels": 2},
  "grid": {"tempo": 124.0, "time_signature": "4/4", "beats": [...], "downbeats": [...],
           "tempo_map": [[0.0, 124.0], [96.7, 123.6]], "source": "beat_this" | "librosa"},
  "key": {"name": "A minor", "tonic": 9, "mode": "minor", "confidence": 0.71},
  "chords": [{"start": 0.48, "end": 2.42, "label": "Am", "root": 9, "quality": "min", "conf": 0.8}],
  "sections": [{"start": 0.0, "end": 31.4, "label": "A"}],          // may be []
  "separation": {"preset": "best", "device": "cuda", "gpu_seconds": 58.1,
    "chain": [{"step": "vocals", "model": "mel_band_roformer_kim_ft2_bleedless_unwa.ckpt", "input": "mix", "seconds": 14.2},
              {"step": "drums_bass_other", "model": "htdemucs_ft.yaml", "input": "instrumental", "seconds": 21.0},
              {"step": "drum_pieces", "model": "MDX23C-DrumSep-aufr33-jarredou.ckpt", "input": "drums", "seconds": 7.9}]},
  "tracks": [
    {"id": "vocals", "name": "Vocals", "role": "vocals", "kind": "pitched", "color": "#e0a458",
     "audio": {"path": "stems/vocals.flac", "silent": false, "peak_db": -1.2, "lufs": -18.3},
     "sub_stems": [],
     "character": {"strategy": "sampler", "instrument": "unknown", "polyphonic": false, "synth_like": false,
                   "wet": true, "low_confidence": false, "scores": {}},
     "transcription": {"engine": "rmvpe", "fallback": "basic_pitch", "n_notes": 412, "quantized": true, "subdivision": 4},
     "notes": [[62, 12.41, 12.90, 96, 0.91]],
     "f0": {"path": "analysis/vocals_f0.json", "hop_s": 0.01},          // optional
     "instrument": {"sampler": "instruments/vocals/instrument.json", "sfz": "instruments/vocals/vocals.sfz",
                    "dspreset": "instruments/vocals/vocals.dspreset", "patch": null, "vital": null},
     "effects": {"eq": {"bands": [{"type": "peaking", "freq": 63, "gain_db": -3.1, "q": 1.0}], "match_bands": null},
                 "reverb": {"rt60_s": 1.2, "wet": true, "ir": "effects/vocals_ir.wav", "mix": 0.2}},
     "loops": [{"path": "loops/vocals_2bar_124bpm_Am_01.wav", "start": 31.0, "bars": 2, "bpm": 124.0}],
     "phrases": [{"path": "phrases/vocals_01_57-69.wav", "start": 12.4, "end": 15.9, "lo": 57, "hi": 69}],
     "midi": "midi/vocals.mid"},
    {"id": "drums", "role": "drums", "kind": "drums", "audio": {"path": "stems/drums.flac"},
     "sub_stems": [{"id": "kick", "path": "stems/drums/kick.flac", "gm": [36]}, {"id": "snare", "path": "...", "gm": [38]},
                   {"id": "toms", "gm": [45, 47, 50]}, {"id": "hh", "gm": [42, 46]}, {"id": "ride", "gm": [51]}, {"id": "crash", "gm": [49, 57]}],
     "transcription": {"engine": "drums_hier", "fallback": "drums_heuristic"},
     "instrument": {"sampler": "instruments/drums/kit.json", "sfz": "...", "dspreset": "...", "patch": null, "vital": null},
     "effects": null, "loops": [], "phrases": [], "midi": "midi/drums.mid"},
    {"id": "other", "instrument": {"patch": "instruments/other/patch.json", "vital": "instruments/other/other.vital", "...": "..."}}
  ],
  "midi": {"song": "midi/song.mid", "chords": "midi/chords.mid"},
  "exports": {"dawproject": "project.dawproject", "readme": "README.txt"},
  "stages": [{"name": "separate", "status": "ok", "seconds": 58.1, "detail": "best"},
             {"name": "beats", "status": "fallback", "seconds": 3.2, "detail": "beat_this unavailable -> librosa"}]
}
```
`instrument.json`: `{"type":"multisample","name","amp_env":{a,d,s,r},"zones":[{"path","root","lo","hi","lovel","hivel","rr","gain_db","loop":{"start","end","crossfade"}|null}]}`.
`kit.json`: `{"type":"drumkit","pieces":{"kick":{"gm":36,"zones":[{"path","lovel","hivel","rr"}]}, ...}}`.
`patch.json`: `{"type":"subtractive","mono","gain","glide_s","oscillators":[{"wave":"saw|square|triangle|sine|noise","level","detune_cents","octave"}],"unison":{"voices","detune_cents"},"filter":{"type","cutoff_hz","q","env_amount_hz","key_track"},"filter_env":{a,d,s,r},"amp_env":{a,d,s,r},"fit":{"source","waveform","score"}}`.

**Asset URLs.** Gradio `flip` output 2 = the on-disk `project.json` dict plus
`"_server": {"bundle_root": "<abs path under WORK_ROOT>"}`. Frontend:
`assetUrl(rel) = ${baseUrl}/gradio_api/file=${encodeURI(bundle_root + "/" + rel)}` — identical against
`https://nakas-stemflipper.hf.space` and `http://127.0.0.1:7860`; requires
`demo.launch(allowed_paths=[str(WORK_ROOT)])`. Deep link `?backend=<url>&bundle=<bundle_root>` reloads a
finished run; `?fixture=song` loads the public fixture. Dropping a bundle zip on the page resolves assets
to blob URLs via fflate (P5).

---

## 2. Phases

Order: P0 → P1 → P2 → P3 (backend, local only) → P4 (frontend engine + mixer; **first joint Space +
Pages deploy at the end of P4**, legacy page retired then) → P5 (editing + client exports) → P6
(polish/quota/docs). P4 can start right after P0 against `public/fixtures/song/` if two workers are
available. Every phase keeps `pytest -m "not slow"` green and the live site working.

### P0 — Environment, contract, scaffold, CI
1. **Env**: `uv venv --python 3.10 .venv && uv pip install -r requirements.txt`; new
   `requirements-dev.txt` (pytest, gradio_client, sfzlint, huggingface_hub[cli], ruff); optional
   `dataset/requirements.txt`. Verify `audio-separator[cpu]>=0.47,<0.48` and explicit `torch>=2.8` install
   on py3.10/arm64 before bumping pins (Invariant #2). **USER STEP (interactive): `hf auth login`**;
   deploy script also accepts `HF_TOKEN` for headless runs.
2. `tests/test_dataset.py`: `pytest.importorskip("torchsynth")` at module top so CI without dataset deps is green.
3. Contract: `stemflipper/export/` package — move `export.py` → `export/__init__.py` (split in P3);
   add `export/project_json.py` with `build_project()` skeleton, `validate_project(d) -> list[str]`,
   and `from_v1(manifest, notes, bundle_dir)` shim.
4. `scripts/make_web_fixture.py`: `tests/make_fixture.py::build_fixture` → `run_pipeline` with
   `tests/test_pipeline.py::_fake_separator` → `from_v1` → `web/public/fixtures/song/` (regenerated in P3 from the real v2 pipeline).
5. Web scaffold: `web/package.json` (vite, typescript, preact, @preact/signals, fflate; dev: vitest,
   puppeteer, jsdom, midi-file), `vite.config.ts` (`base: "/stemflipper/"`), `index.html` = meta-refresh to
   `./legacy/` for now, `public/legacy/index.html` = current page verbatim, `public/web/index.html` redirect
   (old deep link); `src/api/backend.ts` ported from `web/index.html` (join BEFORE stream; `session_not_found`
   retry; `credentials:"omit"`; SSE over `fetch` + `ReadableStream` so a Bearer header is possible; `cancel()`); vitest for the SSE parser.
6. CI: `.github/workflows/python.yml` (ubuntu, setup-python 3.10, setup-uv, ffmpeg+libsndfile1, `pytest -m "not slow"`);
   `.github/workflows/pages.yml` (node 22, `npm ci && npm test && npm run build`, upload `web/dist`, deploy-pages;
   permissions `pages: write, id-token: write`). Switch Pages: `gh api -X PUT repos/andrewnakas/stemflipper/pages -f build_type=workflow`.
   Remove root `index.html` + `.nojekyll` after the first workflow deploy succeeds.
7. `scripts/deploy_space.py`: `ALLOW = [..., "stemflipper/**/*.py"]`, `ignore_patterns=["**/__pycache__/**","*.pyc"]`,
   `--dry-run` (prints the file list), `HF_TOKEN` support, drop `create_repo`.
8. Docs: HANDOFF "v2 STATUS" + phase table; README run-locally block → `uv`.

**Gate**: fast tests green; `cd web && npm ci && npm test && npm run build` OK; Pages workflow green and
the site root redirects to `/legacy/` which still drives the live Space; `deploy_space.py --dry-run` lists nested files.

### P1 — Separation engines, single GPU stage, analysis
1. `separation/engines.py::run_model(...)` generalised from `separate.separate_stems` (reuse
   `default_model_dir`; `custom_output_names`); per-`model_filename` `Separator` cache `_SEPARATORS`.
2. `separation/registry.py`: specs `vocals_roformer` (patterns in priority: `kim.*ft.?2.*bleedless`,
   `vocals revive v3`, `vocals fv7b`, `Vocals by Kimberley`), `drumsep` (`drumsep`), `demucs_ft`, `demucs`,
   `demucs_6s`; `resolve()` via `list_supported_model_files()` → static fallback offline; cached.
3. `separation/hierarchical.py::separate_hierarchical(input, stems_dir, preset, run_model=..., six=False, model_dir=None, progress=None) -> SeparationResult{stems, drum_sub, chain, residual_db}` (§3.1).
   `PRESETS = {fast: [demucs], balanced: [vocals_roformer, demucs, drumsep], best: [vocals_roformer, demucs_ft, drumsep]}` (+ `demucs_6s` when `six`).
4. `neural.py::run_neural_stage(input_path, workdir, preset, opts) -> NeuralOutputs` — hierarchical
   separation; `analysis.beats.beat_this_beats(mix)`; `mono_pitch.rmvpe_f0(vocals)`; `piano.transcribe_piano`
   for `piano` (6s) and `other`. Each optional + try/except into `NeuralOutputs.errors`. Device:
   cuda → mps → cpu. Returns only picklable paths/arrays (crosses the ZeroGPU fork).
5. `analysis/beats.py`, `analysis/grid.py` (`build_grid`, `infer_time_signature` from downbeat spacing,
   `tempo_map_from_beats`, `seconds_to_beats`/`beats_to_seconds`); `analyze.analyze_audio(y, sr, neural=None)`
   extended but back-compatible (`tests/test_analyze.py`).
6. `analysis/chords.py::estimate_chords`; `analysis/sections.py::estimate_sections` (best-effort).
7. `pipeline.py`: `_run_stage(name, fn, *, fallback=None) -> (value, StageResult)` runner (logs
   `logging.exception`, never raises for frontier stages); new signature
   `run_pipeline(input_path, output_dir, *, preset="balanced", six=False, model_dir=None, progress=None, make_zip=True, neural_fn=None, separate_fn=None, use_panns=False, use_synth=False, workers=3)`;
   `neural_from_separate_fn(separate_fn)` adapter keeps `tests/test_pipeline.py::_fake_separator` + `test_app` working.
8. `app.py`: `gpu_stage = spaces.GPU(duration=estimate_gpu_seconds)(neural.run_neural_stage)` (guarded);
   module-level `neural.preload(...)` when `SPACE_ID` is set (cuda emulation), skip on failure. Old `flip`
   outputs kept until P3.
9. Tests: `tests/test_separation.py` (fake `run_model` synthesising stems from the fixture: stems sum ≈ mix
   (residual < −40 dB), drum pieces present, chain provenance, `fast` has no drumsep, registry regex-over-fallback
   + offline fallback); `tests/test_analysis_grid.py` (3/4 vs 4/4 inference, tempo_map, chords on fixture = Am-dominant,
   key A minor); beat_this test skipped unless checkpoint cached; real roformer/drumsep test marked `slow`.
10. Deps: `beat-this>=1.1` (verify import first). Bump audio-separator (P0).

**Gate**: fast tests green (+≈15); `python -m stemflipper tests/assets/mix.wav --preset fast` on CPU/MPS builds
a bundle; `pytest -m slow -k hierarchical` on the 16 s fixture runs roformer → htdemucs_ft → drumsep locally
(MPS) and writes 6 drum pieces; `separation.chain` lists 3 steps.

### P2 — Transcription engines and policy
1. `transcription/basic_pitch.py`: move `transcribe_pitched`; `THRESHOLDS` per stem (bass: onset 0.6 /
   frame 0.4 / min 80 ms / 30–350 Hz; vocals 60–1500; guitar 80–1400 onset 0.5; piano 27–4200; other defaults). Keep `_onnx_model_path`.
2. `transcription/piano.py`: move `transcribe_piano` / `_get_piano_transcriptor(device)`.
3. `transcription/mono_pitch.py`: `pyin_f0`, `rmvpe_f0` (weights via
   `hf_hub_download("lj1995/VoiceConversionWebUI", "rmvpe.pt")`, missing → None), `f0_to_notes(f0, hop_s, conf, min_len_s=0.06, cents_tol=60)`
   (median-filter cents; segment on voicing gaps / jumps > tol; pitch = round(median cents); velocity from RMS; confidence = voiced fraction × stability).
4. `transcription/drums.py`: keep `transcribe_drums`; add `transcribe_drums_hier(sub_stems, sr)` (§3.2).
5. `transcription/policy.py::transcribe_track(name, path, y, sr, character, neural, sub_stems) -> {"notes","is_drum","engine","fallback"}`:
   drums → hier if sub_stems else heuristic; vocals → rmvpe→notes (pyin fallback), prefer basic-pitch if router says
   polyphonic and mono notes < 0.3× bp notes; bass → pyin vs basic-pitch by agreement (same pitch-class within 60 ms),
   octave sanity (median pitch 28–55); piano stem / `is_keys` / (polyphonic ∧ piano notes ≥ 0.5× bp) → ByteDance; else basic-pitch.
   Every note gets `confidence`.
6. `transcribe.py` facade (keeps `tests/test_transcribe.py::test_keys_falls_back_to_basic_pitch` monkeypatch working).
7. Pipeline per-stem stage: route → `policy.transcribe_track` → `cleanup.clean_notes` → `quantize.quantize_notes` in a
   `ThreadPoolExecutor(max_workers=workers)` (tests use `workers=1`).
8. Tests: `tests/test_mono_pitch.py` (synthetic sweep → 8 notes ±1 semitone; gaps; silence → []);
   `tests/test_drums_hier.py` (fixture drums band-split into fake pieces → kick/snare/hat ≥ 0.9 via
   `tests/test_transcribe.py::_match_rate`; open/closed hat by decay; tom buckets); `tests/test_policy.py` (engine matrix with
   stubs; fallbacks; never raises on silent); extend `tests/test_detection_pipeline.py` helpers for drum rows.

**Gate**: fast tests green; fixture bass via pyin path ≥ 0.9 match; a real song prints per-track engine + counts;
drums: kick ≈ snare ± 50 % on 4/4 pop, hats ≥ 2× kicks.

### P3 — Samples, instruments, loops, exports (drop RPP), new API
1. `samples/hits.py` + `samples/drumkit.py::build_kit(pieces|stem+notes, out_dir)` (§3.2) → `instruments/drums/samples/<piece>_v<L>_rr<N>.wav`, `kit.json`.
2. `samples/multisample.py::build_multisample(name, y, sr, notes, f0, out_dir, patch)` (§3.3) → `instrument.json`;
   `sampler.build_sampler` becomes a thin legacy wrapper (`tests/test_sampler.py`: 3 regions, lokey 0/hikey 127, one_shot drums).
3. `samples/loops.py::extract_loops(y, sr, grid, sections, name, key, out_dir, max_loops=8)` (§3.4); `samples/phrases.py::chop_phrases`.
4. Writers: `writers/sfz.py` (groups per velocity layer `lovel/hivel`, RR `seq_length/seq_position`,
   `loop_mode=loop_continuous loop_start loop_end`, `ampeg_*` from `patch.amp_env`, `one_shot` for drums);
   `writers/dspreset.py` (`<DecentSampler><groups><group attack.. release..><sample path rootNote loNote hiNote loVel hiVel loopStart loopEnd loopEnabled/>…</groups><effects>…`);
   `writers/instrument_json.py`.
5. `synthfit.py`: `build_patch`, `render_patch` (numpy: band-limited saw/square as in `tests/make_fixture.py::saw_note`,
   scipy LPF, ADSRs), `search_patch` (grid over cutoff × env_amount × wave, log-mel L1, ≤2 s), `write_patch`; `.vital` from patch.
6. `effects.py::curve_to_bands`; when a patch exists render 20 s and store `match_eq(render, stem)` as `effects.eq.match_bands`.
7. `export/midi.py` (mido; tempo map from `grid.tempo_map`, time sig, section markers, chord track, drums ch 10, per-stem mids;
   ticks via `grid.seconds_to_beats`); `export/dawproject.py` moved; `export/readme.py`; `export/bundle.py` (FLAC stems,
   `stems/drums/*.flac`, WAV 24-bit samples/loops/phrases, zip); `export/project_json.py::build_project/write_project`;
   `notes.json` kept as a derived file for one release; `manifest.json` = `{"schema_version":2,"see":"project.json"}`.
8. `pipeline.py` final flow: load → neural (GPU) → grid/key/chords/sections → per-track (pool): route → transcribe →
   clean → quantize → effects → patch → samples → writers → MIDI → DAWproject → project.json → README → zip. Remove `write_rpp`.
9. `app.py`: `flip(audio, preset, six) -> [zip_file, project_json]` (`api_name="flip"`, fn_index 0); `WORK_ROOT` +
   `allowed_paths`; `_prune_workdirs(max_age_h=6)`; Gradio UI = upload, preset dropdown, "6-stem (experimental)" checkbox,
   summary table from `project.tracks`, zip, and a link to `https://andrewnakas.github.io/stemflipper/?backend=…&bundle=…`;
   `MAX_AUDIO_MINUTES=8`, `max_file_size="40mb"`. `__main__.py` flags.
10. Tests: `_assert_complete_bundle` → project.json validates, ≥4 `stems/*.flac`, `midi/song.mid`, instrument json/sfz/dspreset,
    no RPP; `test_app.py` → `[zip, project]` with absolute `_server.bundle_root`; `test_export.py` → drop RPP, add tempo-map/marker/chord
    round-trip; `tests/test_samples.py` (kit ≥3 pieces in fallback mode, zero-cross trimmed, fades; bass multisample 3 roots + pitch
    verify; loops start on fixture downbeats (multiples of 2.0 s), filename has `120bpm`; **sfzlint passes**; `.dspreset` parses);
    `test_synthfit.py` + render non-silent + search ≥ warm-start; `tests/test_project_json.py`.
11. Deps: `pyloudnorm>=0.2` (optional import), `sfzlint` dev-only. Verify installs first.

**Gate**: fast tests green (≈150); `python -m stemflipper <real song> --preset best` on the Mac (MPS): 6 drum pieces,
layered kit.json, ≥12 bass zones, bar-aligned loops, `song.mid` opens in a DAW with tempo map + markers, `.dspreset` loads
in DecentSampler, `.sfz` in sfizz/Sforzando, `.dawproject` in Bitwig/Studio One; `make_web_fixture.py` regenerates the v2 fixture.

### P4 — Frontend engine and mixer → first joint deploy
1. `model/types.ts`, `model/store.ts`, `model/grid.ts`; `api/assets.ts` (decode on demand, mono downmix unless "stereo stems"),
   `api/quota.ts`; `ui/UploadPanel.tsx` (drop, preset/six, progress + `project.stages` list); `ui/SettingsPanel.tsx`
   (backend URL: Space / `http://127.0.0.1:7860` / custom; HF token in localStorage; stereo stems; keep song in browser).
2. `engine/graph.ts::buildGraph` — per track `laneGains → input → EQ (biquads, bypassable) → StereoPanner → volume → mute → master`,
   `send → Convolver (IR)`; master `gain → DynamicsCompressor(limiter) → Analyser → destination`; graph persists across
   play/stop/seek/mute (only gains change — fixes today's rebuild-everything design).
3. `engine/transport.ts` (§3.5); lanes: `audioLane` (start(when, offset) on play/seek/wrap), `synthLane` (voices from
   patch.json, unison, filter env, amp ADSR, mono/glide, ≤24 voices; fallback = today's 2-saw voice + `playDrum`),
   `samplerLane` (zone by pitch/vel + RR, `playbackRate = 2^((pitch-root)/12)`, loop points, 30 ms release, lazy zone decode).
4. `engine/render.ts::renderTracks` (same `buildGraph` on OfflineAudioContext, schedule all notes up front); `export/wav.ts`.
5. UI: `App.tsx` (header/transport, track headers left + lanes right, shared viewport), `Ruler.tsx` (bars:beats from
   downbeats/beats), `WaveformLane.tsx` (peaks cached per zoom bucket), read-only `PianoRoll.tsx` (viewport-aware, redraw on change/playhead only),
   `MixerStrip.tsx`/`TrackHeader.tsx` (lane blend sliders + Original/Synth/Sampler/50-50 presets, M/S, pan, vol, meters, FX toggle,
   drum sub-stem expander), `TransportBar.tsx` (play/stop, bars:beats clock, BPM, loop region on ruler, metronome, zoom), `keymap.ts`.
6. `index.html` becomes the app; `?backend=&bundle=` deep link; `?fixture=song`; `window.__sf = {ready, state, renderMix(), exportZip()}` for smoke.
7. Tests: vitest for grid, scheduler cursor math, lane gain routing, wav; `scripts/web_smoke.mjs` (§6).
8. **Deploy**: `python scripts/deploy_space.py` (backend v2 API) and push (Pages) in the same commit; delete `public/legacy/`.

**Gate**: `npm test` green; smoke: fixture loads, zero console errors, `renderMix()` RMS > 0.01 with each lane solo'd, meters move;
live cross-origin run from github.io against the Space succeeds; manual: three lanes in sync, mute/solo/pan/vol/EQ/reverb audible, loop wraps clean.

### P5 — Piano-roll editing, undo/redo, client exports, persistence
1. `model/commands.ts` (§3.6) + `model/notes.ts`; store gets `history`, `selection`, `tool` (select/draw/erase), `snap` (1/4…1/16, triplets, off).
2. `ui/PianoRoll.tsx` editing: hit-test, marquee, drag move (snapped), edge resize, double-click add, Delete, Alt-drag duplicate,
   Cmd/Ctrl-Z / Shift-Z, Q quantise, arrow nudges; `VelocityLane.tsx`; drum rolls use piece rows from `sub_stems[].gm`.
3. Live edit → engine: re-bisect cursors; release voices of removed notes; edits feed `render.ts`.
4. `export/midi.ts` (SMF-1 with tempo map, time sig, drums ch 10, chords), `export/bundle.ts` (fflate: `midi/*.mid`,
   `render/<track>.wav`, `render/mix.wav`, `project.json` with `"edited": true`, optional instruments/loops/phrases); `ExportPanel.tsx`.
5. `model/persist.ts` (IndexedDB keyed by bundle_root|hash; Recent list; restore edits/mixer); zip-drop loader.
6. Tests: vitest commands (do/undo/redo/coalesce; invariants), quantise, MIDI round-trip via `midi-file`, zip entries; smoke extended (edit → undo → export → parse).

**Gate**: `npm test` + smoke green; manual: edit while playing, undo/redo 20 steps, exported `song.mid` imports into a DAW on the grid at tempo, rendered stems aligned with originals.

### P6 — Polish, quota, docs
1. Quota UX (`api/quota.ts`): retry time, "Add HF token", "Use local backend", "Use fast preset"; show estimated GPU seconds before running.
2. Cold weights: HF model repo `nakas/stemflipper-weights` (model repos are free) mirroring preset checkpoints + yaml configs,
   `rmvpe.pt`, ByteDance piano ckpt, beat_this `final0`; README `preload_from_hub:`; `neural._link_preloaded_weights()` at import; online download stays the fallback.
3. `README.md` front matter (`sdk_version` verified locally, `suggested_hardware: zero-a10g`) + body (v2 bundle map, presets,
   GPU-seconds table, token/local-backend instructions, licensing unchanged); `HANDOFF.md` v2 status + invariants 7–10; bundle README.txt.
4. Memory/perf: lazy sub-stem decode, buffer release, client-side duration cap, peaks in a Worker if janky.
5. Re-measure `neural.GPU_COST` from live runs. Follow-ups noted, not built: Ableton `.als`, `xlarge` GPU, sections UI, Transkun piano.

**Gate**: live runs with and without token (Authorization header honoured; anonymous quota not consumed when token set);
`gpu_seconds` ≤ 20 fast / ≤ 90 best; both workflows + fast tests green.

---

## 3. Key algorithms

### 3.1 Hierarchical separation (`separation/hierarchical.py`)
```
mix = stereo float32
fast:  d,b,o,v = run_model(mix, demucs)
else:  v, inst = run_model(mix, vocals_roformer)            # "Vocals","Instrumental"
       d,b,o,v_res = run_model(inst, demucs|demucs_ft); o += v_res   # trust roformer vocals; fold residual into other
if drumsep in chain and not silent(d): pieces = run_model(d, drumsep)   # kick,snare,toms,hh,ride,crash
       resid = d - sum(pieces); if rms_db(resid) > -40: pieces["drums_other"] = resid
if six: g,p,o2,(b2,d2,v2) = run_model(o, demucs_6s); o = o2+b2+d2+v2; flag guitar/piano low_confidence
trim to len(mix); consistency = mix - sum(stems); stems["other"] += consistency   # sum-to-mix → "Original" lanes reproduce the song
record chain[{step, model, input, seconds}], residual_db; gpu_seconds = total neural wall time
```
Write intermediates to disk between steps (RAM: ≤ 4 stems + 6 pieces of an 8-min stereo song ≈ 2 GB otherwise).

### 3.2 Drum hits: transcription, isolation, kit (`transcription/drums.py`, `samples/hits.py`, `samples/drumkit.py`)
```
per piece: env = onset_strength(hop 256); onsets = peak_pick(delta[piece], wait[piece])   # hh wait 2 frames, kick 6
  seg = y[t-5ms : t+WIN[piece]] (kick 300 ms, snare 250, toms 400, hh 200, ride 800, crash 1500)
  velocity = clip(30 + 97*(peak_db - p05)/(p95 - p05), 1, 127) using piece-level percentiles
  gm: kick 36, snare 38, ride 51, crash 49 (2nd centroid cluster → 57); toms: autocorr f0 → ≤3 clusters → 45/47/50; hh: decay > 0.15 s → 46 else 42
  bleed guard: drop snare/hh onset within 20 ms of a kick onset when its peak is > 12 dB below the kick
  note = {gm, t, t+min(decay, 0.25 | 1.0 cymbals), velocity, confidence = env[t]/max(env)}
fallback (no pieces): existing 3-class heuristic (transcribe_drums)
isolation: no other onset in the same piece within [-30 ms, +decay]; other pieces' RMS over the window < peak - 20 dB
trim: start = zero_cross_snap(t-5 ms); end = min(next_onset-10 ms, decay to -50 dB, cap); fade 2 ms in / 20 ms out; peak -1 dBFS
dedupe: cosine(mean MFCC) > 0.97 → keep loudest; layers: kmeans on peak_db (≤3) → lovel/hivel; ≤4 round-robins per layer
```

### 3.3 Multisample + loop points (`samples/multisample.py`)
```
cands = notes with dur ≥ 0.12 s, no overlapping note, conf ≥ 0.5
  f0 = pyin(middle 60 %); cents = 1200*log2(f0/midi_hz(pitch)); keep |cents| ≤ 50 ∧ voiced ≥ 0.8; score = dur*(1-|cents|/50)*(1-rms_cv)
per pitch keep best; 2 velocity layers when peak spread > 8 dB; target roots every ≤3 semitones, gaps borrowed from nearest root; zones lo/hi = midpoints (as sampler._render_sfz)
loop (router sustain_ratio ≥ 0.6 ∧ dur ≥ 0.5 s): period = sr/f0; search a ∈ [0.4,0.9]·len step period, L ∈ {8,16,32,64} periods;
  err = ||x[a:a+2P] - x[a+L·P : …]||²/||x[a:a+2P]||²; accept min err < 0.05 → {start a, end b, crossfade min(2P, 10 ms)}
amp_env from patch.amp_env else {a 0.005, d 0.1, s 1, r 0.25 (0.4 if wet)}
```

### 3.4 Loop selection (`samples/loops.py`)
```
bars = downbeats (fallback: every numerator beats); for L in (1,2,4): windows = consecutive L-bar spans
feat = [mean chroma_cqt, 16-bin onset histogram per bar, rms_db]; drop rms < median-6 dB or > 25 % silence
agglomerative cosine clusters (thr 0.15) → representative nearest centroid (prefer section starts); rank by size×energy; ≤ max_loops (≥1 per L)
write with 5 ms fades at zero-cross bounds → loops/<stem>_<L>bar_<bpm>bpm_<key>_<nn>.wav; entry {path, start, bars, bpm}
```

### 3.5 Look-ahead scheduler + lanes (`engine/transport.ts`)
```
Clock: songTime(ctx_t) = base.song + (ctx_t - base.ctx); rebase on play/seek/loop-wrap
tick 25 ms (setInterval; rAF only for UI): horizon = sNow + 0.12
  per track, per lane (synth/sampler) with gain > 0: while notes[cur].start < horizon: noteOn(ctxTime(start)), noteOff(ctxTime(end)); cur++
  loop: when horizon ≥ loop.end and !wrapScheduled: wrapCtx = ctxTime(loop.end); pendingRebase(loop.start, wrapCtx);
        audioLanes.restartAt(wrapCtx, loop.start); cut voices at wrapCtx (10 ms release); cur = bisect(notes, loop.start)
seek(s): rebase(s, now+0.03); audioLanes.restartAt(now+0.03, s); releaseAll(); cur = bisect(notes, s)
edits: notes replaced → cur = bisect(notes, sNow); sounding voice whose note id vanished → release
routing: laneGain[original|synth|sampler] → track input (see graph.ts)
```

### 3.6 Note-edit commands (`model/commands.ts`)
```
Note{id, pitch, start, end, vel, conf}; ids = trackId:index on load, counter for new
NoteEditCommand{trackId, before: Map<id, Note|null>, after: Map<id, Note|null>, label, coalesceKey?}; apply/revert symmetric
History{undo[], redo[], exec(cmd): merge into top if same coalesceKey within 500 ms else push; redo = []}
Drags: pointerdown snapshots before; pointermove writes store.previewNotes (no history); pointerup → exec
Quantise / velocity scale / delete / add all emit the same shape → uniform undo + serialisable diffs (persist.ts)
```

### 3.7 ZeroGPU dynamic duration (`app.py::estimate_gpu_seconds(input_path, workdir, preset, opts)`)
```
minutes = clamp(duration_of(input)/60, 0.25, 8); per_min = {fast: 4, balanced: 12, best: 18}[preset] + (4 if six)
return int(clamp(12 + 3 + per_min*minutes, 30, 240))      # re-measure in P6 → neural.GPU_COST
```

---

## 4. Migration / compatibility
- **Gradio API**: `flip(audio, model) → [zip, summary, 4 previews, notes]` becomes `flip(audio, preset, six) → [zip, project]`
  in P3, but the Space is **not redeployed until the end of P4**, when the new frontend ships in the same commit and the
  legacy page is deleted. No dual API.
- **Tests**: `_fake_separator` keeps working via `neural_from_separate_fn` (P1); `_assert_complete_bundle` and `test_app.py`
  updated in P3; `test_rpp_block_balanced` deleted; `test_dawproject_structure` unchanged; transcribe/sampler/router/effects/
  synthfit/analyze suites unchanged via facades; `test_dataset.py` gains `importorskip` (P0).
- **CLI**: `--model` aliases (`htdemucs→fast`, `htdemucs_ft→best`, `htdemucs_6s→best --six`).
- **Deploy allow-list** recursive + `--dry-run` + `HF_TOKEN` (P0). **Pages** legacy → workflow (P0). Old `/web/` link redirects.
- **Docs**: HANDOFF v2 STATUS/queue + invariants 7–10 (P0, updated every phase); README + bundle README.txt (P3/P6).
- **Bundle v1 → v2**: `notes.json` retained one release; `manifest.json` stub pointing at `project.json`.

## 5. Risks and mitigations
- **ZeroGPU quota**: anonymous 2 min/day vs `best` ≈ 60–90 s → 1–2 songs. One GPU call per song; `fast` default for
  anonymous users; token setting; local backend mode; pre-run estimate; clear quota UX. Verify the Bearer header live (P6).
- **`Authorization` header cross-origin preflight**: may be refused by the Space's CORS. Fallback: token usable only from
  an hf.space origin (documented) — the local-backend mode is unaffected.
- **GPU fork state**: lazily loaded models inside `@spaces.GPU` may not persist; module-level preload under emulation
  when `SPACE_ID` is set, in-call load as fallback; caches are best-effort.
- **Model filename drift**: regex lookup + static fallback + provenance in `separation.chain`; `slow` test against the live registry.
- **Server memory**: 8-min cap, disk between chain steps, FLAC bundle. **Browser memory**: decode on demand, mono by default,
  sub-stems only when expanded, release idle buffers, memory estimate shown.
- **Safari**: create/resume AudioContext in the click handler, no AudioWorklet, FLAC OK on 17+, IndexedDB caching opt-in.
- **Cold weights**: `preload_from_hub` mirror (P6) + import-time symlink; never download inside the GPU call.
- **Thread pool**: `workers=1` in tests, cap 3, `OMP_NUM_THREADS=2` per worker on the Space.
- **basic-pitch numpy-2/tflite trap**: keep ONNX forcing + `test_basic_pitch_backend_produces_notes`.
- **Licensing**: everything added is MIT (beat_this, RVC/RMVPE, DrumSep via audio-separator, community RoFormer ckpts —
  MUSDB18-trained risk already documented); none of the NC/GPL items.

## 6. Verification
- **Python fast** (`pytest -m "not slow"`, every commit): existing suites + `test_separation`, `test_analysis_grid`,
  `test_mono_pitch`, `test_drums_hier`, `test_policy`, `test_samples` (incl. sfzlint), `test_project_json`, extended
  `test_export`/`test_pipeline`/`test_app`. Reuse `_match_rate`, `_corrupt/_grid_tightness/_onset_jitter`,
  `_fake_separator/_assert_complete_bundle`, `make_fixture.build_fixture`.
- **TS** (`npm test`): grid math, scheduler cursor logic, commands/history, notes ops, MIDI writer (parse back with `midi-file`),
  WAV encoder, SSE parser, zip builder.
- **Slow / opt-in** (`pytest -m slow`): real htdemucs (existing), real `best` chain on the fixture (MPS), beat_this + RMVPE when cached.
- **Integration** (`scripts/e2e_local.sh`): `make_web_fixture.py` → `validate_project` OK → `npm run build && npm run preview` →
  `node scripts/web_smoke.mjs` (puppeteer, or the `browser-automation` skill): open `/?fixture=song`, wait `__sf.ready`, zero
  console errors/failed requests, `renderMix()` RMS > 0.01 per lane solo, edit + undo via `__sf.state`, `exportZip()` → unzip
  in node → `midi/song.mid` parses with expected note count, `render/mix.wav` header valid. Plus `test_app.py` via `gradio_client` with the GPU stage stubbed.
- **Real-song manual smoke** (per release; record in HANDOFF): Space wall time + `gpu_seconds` (fast ≤ 20 / best ≤ 90),
  no `failed` stages; vocals clean, drum pieces distinct; counts (kick ≈ snare ± 50 %, hats ≥ 2× kicks, bass 1–4/bar,
  vocals ≥ 1 note/s when sung, chords mostly diatonic); downbeats on bar lines, tempo ±1 BPM; kit ≥ 4 pieces with ≥ 2 layers
  on kick/snare, ≥ 8 bass zones, loops start on downbeats and loop cleanly; `.sfz` → sfizz, `.dspreset` → DecentSampler,
  `.vital` → Vital, `song.mid` + `.dawproject` → DAW at tempo; editor lanes in sync at bar 1 and bar 60; token vs anonymous quota.

## Critical files
- `stemflipper/pipeline.py` — stage runner, thread pool, new `run_pipeline`, project.json assembly
- `app.py` — single `@spaces.GPU` neural stage with dynamic duration, `allowed_paths`, new `flip` API
- `stemflipper/export/project_json.py` (new) — the contract both sides depend on
- `stemflipper/separation/hierarchical.py` (new; builds on `stemflipper/separate.py`) — RoFormer → Demucs → DrumSep chain
- `stemflipper/transcription/policy.py` (new) — engine selection per stem
- `stemflipper/samples/{hits,drumkit,multisample,loops}.py` (new) — the "builds out samples" core
- `web/src/engine/transport.ts` + `graph.ts` (new; ports the voice code from `web/index.html`) — shared by live playback and offline render
- `web/src/ui/PianoRoll.tsx` + `web/src/model/commands.ts` (new) — editing + undo
- `scripts/deploy_space.py`, `.github/workflows/{python,pages}.yml`, `HANDOFF.md`
