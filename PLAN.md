# StemFlipper — Research & Architecture Plan (Fable handoff)

> ## ⭐ START HERE — Fable onboarding (read this first, in a fresh session)
>
> **You are a Fable planning instance picking up StemFlipper cold.** This document is a
> complete, self-contained handoff — you do **not** need any prior conversation. Everything
> decided so far, all research ground-truth, and all open guardrails are below.
>
> **What StemFlipper is:** a web app — upload any song → AI source-separation into stems →
> break each stem into **editable samples + MIDI + instrument/synth patches + effects** that
> reconstruct the original faithfully → **export a project other DAWs can open.** MVP lives on
> **Hugging Face Spaces**, with an accompanying **HF dataset** and a path toward trained models.
>
> **How this brief was produced:** six parallel research agents swept the 2025–2026 SOTA across
> (1) source separation, (2) audio→MIDI transcription, (3) synth/effect reconstruction,
> (4) DAW export formats, (5) HF Spaces deployment, (6) datasets & training. Their full,
> fully-cited reports are saved next to this file (see Appendix) — **read them for exact
> benchmark numbers, arXiv IDs, HF repo IDs, code snippets, and source URLs.** This brief is the
> distilled map + ground-truth + guardrails; the appendix files are the evidence.
>
> **The 6 locked decisions** (made by the product owner — do not relitigate; see full list in
> "User's scoping decisions"):
> 1. Reconstruction = **both strategies, gated by a per-stem router** (mono+synth→synth-fit;
>    mono+acoustic→sampler; polyphonic→sampler/flag).
> 2. Scope = **app + dataset scaffold** (ship pipeline+Space AND stand up the synthetic-data
>    generator + published HF dataset; *training the estimators is phase 2*).
> 3. Licensing = **research/demo framing** (best open weights; document the MUSDB18 risk;
>    monetization gate later).
> 4. Repo = **one monorepo, layered.**
> 5. **Build sequencing is yours to decide** (this brief lists every component + its dependencies
>    and a suggested first slice you may reorder).
> 6. Deployment = **server-side CPU/GPU on HF Spaces**; **WASM/in-browser is OUT for the MVP**
>    (deferred); add a **thin static frontend** (GitHub Pages / HF static Space) that just calls
>    the Space API — only because it's nearly free.
>
> **The single most important framing to internalize before you plan:** the front half
> (separate→stems→MIDI) is *solved pretrained glue and ships fast*; the back half (editable
> synth/effect reconstruction that *matches* the original) is a *research frontier* — good on
> mono/dry stems, **hard-walled on polyphony**. Build the reliable sampler baseline first, treat
> synth-fit + effects as deepenable "best-effort, editable starting point" stages, and be honest
> in the UX about the ceiling. The **novel moat** is the synthetic (audio→params) dataset.
>
> **Your job now:** turn this into a concrete, sequenced, buildable implementation plan (file-by-
> file milestones, task breakdown, the first walking-skeleton slice, and test gates). Start from
> "Recommended architecture" and "What Fable should sequence," pull specifics from the appendix
> reports, and keep the guardrails in "Licensing" and the "Dependency/environment risk register."

---

## Context — what we're building and why

**StemFlipper** is a web app: upload any song → AI source-separation into stems → each stem is
broken down into **editable samples + MIDI + instrument/synth patches + effects**, arranged to
reconstruct the original as faithfully as possible, and **exportable into other DAWs**. The MVP
lives on **Hugging Face Spaces**, with an accompanying **HF dataset** and a path toward trained
models.

The hard truth from research, stated up front so the plan is honest:
- **Separation → stems → per-stem MIDI** is essentially a *solved, pretrained-glue* problem. Ships now.
- **Reconstructing editable synth patches + effect chains that match the original** is a genuine
  **research frontier**. It works well for *monophonic, dry* stems (sampler or per-note synth
  fitting) and hits a **hard wall on polyphony** (piano, pads, chords) — no turnkey editable
  per-note reconstruction exists in 2026.
- The **one novel research contribution / moat** is a **synthetic (audio → synth-params) and
  (audio → effect-params) dataset** — a real public-data gap — built by rendering known
  parameters forward and learning the inverse.

### User's scoping decisions (locked)
1. **Reconstruction = BOTH, gated by stem character.** A router detects each stem's nature and
   picks a strategy: *mono + synth-like* → synth-param fitting; *mono + acoustic/complex* →
   sampler; *polyphonic* → sampler (whole-phrase) or flagged low-fidelity.
2. **Scope = App + dataset scaffold.** Ship the working pipeline + HF Space **and** stand up the
   synthetic-data generator (torchsynth + differentiable effects) + a published HF dataset repo.
   Training the estimators is phase 2.
3. **Licensing = research/demo framing.** Build on the best *open* weights; **document the
   MUSDB18 commercial-weights risk clearly**; make retrain-on-licensed-data an explicit gate
   *before any monetization*. (See "Licensing" below — this is the single real commercial blocker.)
4. **Repo = one monorepo, layered** (see structure below).
5. **First milestone = Fable's call.** Fable sequences the build; this brief lists every component
   and its dependencies.
6. **Deployment = server-side CPU/GPU on HF Spaces (Gradio/ZeroGPU).** **WASM / in-browser
   processing is OUT of scope for the MVP** — deferred, revisit post-MVP. Add a **lightweight static
   frontend** (GitHub Pages, and optionally an HF `sdk: static` Space) that is a *thin client to the
   Space API* — only "if not much harder" (it isn't: no model code moves client-side). See
   Deployment → "GitHub Pages static frontend."

---

## Recommended architecture

### Repo structure (monorepo, layered)
```
stemflipper/
  core/                        # reusable, framework-agnostic pipeline library
    separate/                  # source separation
    transcribe/                # audio → MIDI, per stem type
    analyze/                   # instrument classification, stem-character router, tempo/key
    reconstruct/               # sampler builder + synth-param fitter + effect estimator
    export/                    # MIDI, manifest, SFZ/DecentSampler, Reaper RPP, DAWproject
    io/                        # audio I/O, temp-file mgmt, model caching
  app.py                       # thin Gradio UI on top of core/ (ZeroGPU entrypoint)
  dataset/                     # synthetic-data generator (torchsynth + dasp) → HF dataset
  web/                         # static frontend (GitHub Pages / HF static Space) → calls the Space API
  requirements.txt
  packages.txt                 # apt: ffmpeg, libsndfile1
  README.md                    # HF Space YAML header (sdk: gradio, ZeroGPU hardware, models:)
```
**One repo → one HF Space (Gradio/ZeroGPU) → one HF dataset repo.** The `core/` library is
importable and testable independently of Gradio; `app.py` is a thin adapter so the pipeline can
also run as a CLI / in notebooks / in the dataset bootstrapping path.

### Processing pipeline (end-to-end)
```
Song (upload)
 │
 ├─ analyze/  tempo + key + time-signature        [librosa; madmom for downbeat/meter if it installs]
 │
 ├─ separate/  → stems                             [audio-separator: htdemucs_6s or BS-RoFormer]
 │      drums · bass · vocals · other [· guitar · piano]
 │
 └─ per stem:
     ├─ analyze/  instrument bucket                [PANNs CNN14 → coarse class]
     ├─ analyze/  stem-character router            [mono vs poly, dry vs wet, synth vs acoustic]
     ├─ transcribe/  → MIDI (note on/off + pitch)  [stem-specific, see table] ← drives everything
     │
     ├─ reconstruct/  (router picks ONE):
     │    mono + synth-like   → per-note synth fit → native .vital/Surge patch   [frontier]
     │    mono + acoustic     → MIDI-driven slice  → SFZ (+ .dspreset)           [reliable]
     │    polyphonic          → sampler (phrase)   → SFZ / flag low-fidelity     [fallback]
     │
     └─ reconstruct/  effects (match-a-target, template chain):
          EQ    → differentiable biquads / dasp auto_eq          [solid]
          Reverb→ blind IR (FiNS-style) → convolution reverb     [solid-enough]
          Comp / Dist / Delay → coarse, best-effort presets      [flagged]
 │
 └─ export/  → downloadable project bundle (see Export section)
```

**Key architectural principles (from research):**
- **The transcribed MIDI drives all downstream reconstruction** — slicing, per-note fitting, and
  labeling all key off note on/off + pitch. This is the single biggest quality lever. Do
  transcription *before* any slicing/fitting.
- **"Match a target," never "invert the unknown chain."** Define the synth/effect chain up front
  and optimize its parameters until the render matches the wet stem (INSTRUMENTAL / ST-ITO /
  DeepAFx-ST paradigm). Blind chain-structure discovery is not reliable enough to depend on.
- **Polyphony is the hard wall.** Detect it and route to the sampler fallback (or flag), rather
  than pretending to produce editable per-note synths for chords/pads/piano.

---

## Component ground-truth (models, libraries, licenses)

### 1. Source separation — engine: `audio-separator`
- **Package:** `audio-separator[cpu]` / `[gpu]` (actively maintained, v0.44.x). Wraps MDX, MDX23C
  (incl. **BS-RoFormer** + **Mel-Band RoFormer**), VR Arch, and Demucs v4; auto-downloads weights
  from HF. API: `Separator().load_model(...); .separate('x.wav')`.
- **Model choices:**
  - **Quality (4-stem):** BS-RoFormer (~12 dB SDR on MUSDB18-HQ with extra data; ~9.8 dB clean).
  - **Speed + 6-stem (adds guitar/piano):** `htdemucs_6s` — **piano stem is weak/bleeds**, gate it.
  - `htdemucs_ft` is a bag-of-4 → ~4× slower than `htdemucs`.
- **Direct `demucs` pip is FROZEN** (author left Meta, repo archived ~Jan 2025). Consume via
  `audio-separator` or a maintained fork; don't build on the raw archived package.
- **Timing:** htdemucs ~24 s GPU / 4–8 min CPU for a 3–4 min song; BS-RoFormer ~60–120 s GPU.
- **VRAM (inference):** htdemucs ~6–7 GB (3 GB floor via `--segment 8`); RoFormer 6–8 GB. The
  "40 GB RoFormer" figure is *training only*.

### 2. Transcription — stem-specific (do NOT use one model for everything)
| Stem | Tool | pip | License | Note |
|---|---|---|---|---|
| Vocals | `basic-pitch` (fallback torchcrepe / PESTO + Viterbi) | `basic-pitch` | Apache-2.0 | pitch bends; ~52% note-F but fine as melody |
| Bass | `basic-pitch` + octave clamp (tight fmin/fmax, Viterbi) | `basic-pitch` | Apache-2.0 | octave errors are the #1 failure mode |
| Drums | librosa onset + spectral-band heuristic → GM map | `librosa` | ISC | **weakest link** — MVP heuristic; see upgrades |
| Piano/keys | ByteDance `piano_transcription_inference` | `piano-transcription-inference` | MIT | **SOTA 96.7% onset F1**, CPU-OK, ~150 MB ckpt |
| Guitar/other | `basic-pitch` | `basic-pitch` | Apache-2.0 | expect ghost notes on residual "other" |

- **Basic Pitch** is the generalist workhorse (Apache-2.0, ~17K params, TFLite on Linux — no full
  TF needed, `pretty_midi`-compatible output).
- **Drums are the honest weak link** — no permissive, pip-installable, pretrained ADT standard in
  2026. Ship the librosa heuristic (kick→36, snare→38, hi-hat→42); it always installs but fails on
  overlapping hits. Upgrades: ADTOF-pytorch (accurate, **CC-BY-NC → non-commercial only**) or
  omnizart drums (MIT but heavy TF deps, isolate).
- **Avoid:** MT3 / YourMT3+ (JAX/TPU-oriented, slow; YourMT3+ is **GPL-3.0**); Onsets&Frames
  (archived TF1); `note-seq` (archived, protobuf conflicts — reimplement quantization on
  `pretty_midi`); `madmom` (fails on Py 3.10+ for transcription; ok for beat if pinned).

### 3. Analysis — instrument classification + router
- **Instrument classifier:** **PANNs CNN14** (`panns-inference`, **MIT**) → AudioSet 527-class
  ontology (~110 instrument classes) + 2048-d embedding. Argmax within the instrument subset;
  ignore generic "Music" tags. Alt: AST (`MIT/ast-finetuned-audioset-...`, BSD-3) if standardized
  on HF `transformers`. Its real job is disambiguating the **"other"** stem into keys/strings/
  synth/guitar. Hard confusions: synth-pad vs strings vs organ; synth-lead vs electric guitar —
  fix later with a small head on PANNs embeddings trained on **OpenMIC-2018 (CC-BY)**. **Do NOT
  train a shipped classifier on IRMAS (CC-BY-NC).**
- **Stem-character router (new code, central to the "gated" design):** classify each stem as
  **mono vs polyphonic** (polyphony estimate from transcription / spectral analysis), **dry vs
  wet** (reverb/tail presence), **synth-like vs acoustic** (PANNs bucket + harmonic structure).
  Output routes to the reconstruction strategy.

### 4. Reconstruction — sampler + synth-fit + effects
**Sampler path (reliable; primary fallback):**
- Emit **SFZ** (plain text, generate with string templating — **no library needed**; `pysfz` is
  abandoned). Opcodes: `sample`, `lokey`/`hikey`/`pitch_keycenter`, `lovel`/`hivel`,
  `loop_mode`/`loop_start`/`loop_end`, `ampeg_*`, `fil_type`/`cutoff`, `seq_*` (round robin).
  Validate in CI with **sfzlint**. Also emit **DecentSampler `.dspreset`** (XML) as secondary.
- **Slice from the transcribed MIDI note boundaries**, not blind onsets. Root = median f0 per
  slice (torchcrepe/pyin) → nearest MIDI note. ~2 samples/octave with player interpolation. Use
  `one_shot` for decaying instruments; loop only sustained pads/organ (zero-crossing + crossfade).
- **Players (satisfy "editable in a DAW"):** **sfizz** (BSD-2, VST3/AU/LV2 — default),
  DecentSampler (free plugin).
- **Failure modes to surface in-product:** stem bleed baked into samples; reverb/delay tails
  smeared past offsets; polyphony can't be cut apart; pitch-stretch artifacts.

**Synth-fit path (frontier; mono + synth-like only):**
- **Target a real editable synth: Surge XT or Vital.** Recipe = **INSTRUMENTAL** (arXiv:2603.15905,
  ≈ a StemFlipper prototype — *read this first*): Demucs → torchcrepe pitch → onset segmentation →
  **per-note CMA-ES** vs a differentiable subtractive synth, multi-scale spectral + MFCC loss
  (`auraloss`). Warm-start with **Syntheon** (`pip install syntheon`, `infer_params(audio,"vital")`
  → loadable Vital preset). Export native `.vital` / Surge patch.
- **Honest walls (build the UX around these):** subtractive structurally *cannot* match FM/
  wavetable timbres — **detect and flag** those; loss plateaus (~"architectural floor");
  ~1 min/optimization; result is a **"great editable starting preset, not a bit-exact clone."**
- **Better-maintained DDSP** if used: `ddsp_pytorch` (IRCAM) not the TF `ddsp` (abandoned,
  numpy<1.24, breaks on Apple Silicon — isolate in a Py-3.10 sidecar if ever needed). Monophonic.
- **RAVE / NAM are the wrong abstraction here** (opaque latents / need a dry DI you don't have).

**Effects path (match-a-target, template chain):**
- **EQ — do this, it works:** fit parametric EQ to spectral envelope via **differentiable biquads /
  `dasp-pytorch` `auto_eq`** + `auraloss` MultiResolutionSTFT. Maps cleanly to any DAW EQ.
- **Reverb — capture an IR, don't invert knobs:** FiNS-style blind RIR → **convolution reverb**.
  More reliable than recovering algorithmic-reverb knobs.
- **Compression (HARD/unsolved blind), Distortion (medium), Delay (time easy):** ship as
  **coarse "best-effort, editable starting point"** presets; be transparent that blind knob
  recovery of dynamics is unsolved. Optionally use **ST-ITO** (ISMIR 2024) to optimize params of
  arbitrary real VST/pedalboard effects against the wet target (you must define the chain; ~1 min;
  can't *remove* existing effects).
- **Apply/host effects & sampler/synth VSTs via `pedalboard`** (Spotify, active, loads VST3/AU,
  renders MIDI offline). ⚠️ **GPLv3** — matters if you *distribute binaries*; limited impact for
  server-side SaaS, but **confirm with legal**.

### 5. Export — DAW project bundle
**MVP bundle (universal — every DAW + Pro Tools imports this):**
```
song/
  stems/*.wav                 separated stems
  midi/*.mid                  SMF Format 1 (Track 0 = tempo map/time-sig/key; per-instrument tracks)
  instruments/*.sfz|.dspreset sliced-sample instruments
  manifest.json               tempo/tempo-map, key, time-sig, track→instrument map, GM/plugin hints, SR
  README.txt
  project.RPP                 Reaper one-click open (plain text — cheapest single-DAW win)
  project.dawproject          phase 2: Bitwig / Studio One / Cubase / Nuendo
```
- **MIDI:** `pretty_midi` (easy note authoring) + `mido` (full meta events). Format 1.
- **Reaper `.RPP`:** plain text, forgiving, no version fragility — emit with templates or
  `Perlence/rpp` (BSD, inactive but works). MIDI embeds inline in `<SOURCE MIDI ...>`.
- **DAWproject (phase 2, full fidelity):** MIT, ZIP(project.xml + metadata.xml + media/plugin
  state) — carries MIDI notes, clips/fades, automation, tempo/time-sig, **embedded plugin state**.
  Python: **`roex-audio/dawproject-py`** (MIT, pure Python, lxml). Reaches Bitwig 5.0.9+ /
  Studio One 6.5+ / Cubase 14 / Nuendo 14; Reaper via ProjectConverter. **Not** Ableton/FL/Logic.
- **Skip for MVP:** AAF/OMF (audio-only, drops MIDI + instrument chains), Ableton `.als` (gzip XML,
  brittle, needs template surgery off the exact Live version), FL `.flp` (PyFLP is GPLv3, alpha,
  modifier-not-generator, no FL21).

### 6. Dataset scaffold — the research moat
- **The gap (confirmed):** no public dataset pairs real recorded audio with the synth-patch /
  effect-chain parameters that produced it. Fill it with **synthetic generation** — render known
  params forward, learn the inverse.
- **Synth params:** **torchsynth / synth1B1** (arXiv:2104.12922) — modular PyTorch synth,
  16,200× real-time, generates (audio, params) pairs on-GPU with **no storage bottleneck**;
  deterministic. And/or render open synths (**Dexed** FM, **Surge XT**, **Vital**) across sampled
  parameter space. **Publish the generator + parameter seeds, not terabytes of audio** (torchsynth
  reproduces audio deterministically) — tiny repo, sidesteps copyright entirely.
- **Effect params:** apply known chains (`dasp-pytorch`: EQ/comp/reverb/distortion) to clean stems
  → (wet audio, params) pairs. Or use differentiable effects and skip a stored dataset.
- **Existing datasets to lean on (for eval / the transcription side):** **Slakh2100** (CC-BY-4.0,
  the one dataset pairing mixture + stems + aligned MIDI + instrument labels — HF
  `Higobeatz/slakh2100`), **MAESTRO** (piano), **E-GMD** (drums), **GuitarSet**, **URMP**,
  **NSynth** (instrument labels). **Avoid for shipped/commercial weights:** MUSDB18, MoisesDB,
  MedleyDB, IRMAS (all non-commercial / CC-BY-NC).
- **Publish on HF Hub** as a `datasets` repo (generator script + seeds + a small hand-annotated
  *real-audio → params* eval set — even a few hundred examples is itself a novel public benchmark).
- **Training = phase 2** (not this build): spectrogram → CNN/AST → param regression, single-GPU
  tractable. The strongest recent template is **Hayes et al. ISMIR 2025** (flow matching → Surge XT,
  full code at benhayes.net/synth-perm) and the **AST sound-matching** paper (arXiv:2407.16643).

---

## Deployment — HF Spaces (Gradio + ZeroGPU)

- **Single monolithic Gradio Space on ZeroGPU under a PRO account ($9/mo).** Do not split into
  multiple Spaces — the whole pipeline is seconds of GPU + seconds of CPU.
- **ZeroGPU is the right tier:** free to *use*, hosting needs PRO. GPU allocated per
  `@spaces.GPU(duration=...)` call then released. **Only wrap the GPU-heavy separation** in the
  decorator; run basic-pitch / reconstruction / export on CPU (minimizes quota burn). Load weights
  at module level on **CPU**, `.to("cuda")` *inside* the decorated function (`.cuda()` at import
  breaks ZeroGPU). No `torch.compile`.
- **Gradio SDK is mandatory** (only framework ZeroGPU supports; also the natural
  upload→process→download UI). Keep the **queue on** (SSE → no browser POST timeout on multi-minute
  jobs). Use `gr.Progress` + `yield` for staged progress. **No Dockerfile** (would disable ZeroGPU).
- **Cost:** ~40 GPU-s/song. PRO base covers ~tens of songs/day; overflow ≈ **$0.07/song**.
  1,000 songs/mo ≈ $9–$75/mo total. A dedicated always-on A10G would be ~$720/mo — ZeroGPU wins
  decisively for bursty demo traffic.
- **Repo files:** `app.py`, `requirements.txt` (spaces, gradio≥4, torch≥2.8, audio-separator,
  basic-pitch, piano-transcription-inference, panns-inference, pretty_midi, mido, librosa,
  soundfile, dasp-pytorch [pin a SHA], auraloss, syntheon, pedalboard, torchsynth), `packages.txt`
  (`ffmpeg`, `libsndfile1`), README YAML (`sdk: gradio`, pinned `python_version`,
  `suggested_hardware: zero-a10g`, `models:` preload). Cache weights at build (README `models:`) or
  set `HF_HOME` + persistent storage — **never download weights inside `@spaces.GPU`**.

### GitHub Pages static frontend (lightweight, optional — "if not much harder")
The MVP is **server-side CPU/GPU on HF Spaces** (above). **WASM/in-browser processing is explicitly
out of scope for the MVP** (dropped by the user — revisit post-MVP). To also have a static-site
presence with near-zero extra work:
- **Simplest, recommended:** a **static landing page on GitHub Pages** (`/docs` folder or `gh-pages`
  branch — plain HTML/CSS/JS, no build step) that explains StemFlipper and **hands off to the live
  Gradio Space** either by (a) a prominent link/button to the Space URL, or (b) an **`<iframe>`
  embedding the Gradio app** (Gradio Spaces are iframe-embeddable), or (c) calling the Space's API
  via **`@gradio/client`** (JS) from the static page so the page itself is the UI and the Space is
  just the compute backend. Option (c) is the nicest UX and still no server to run — the static page
  POSTs the upload to the Space's `/run/predict` endpoint and streams results back.
- **All processing stays on the Space** (the heavy Python pipeline is unchanged). The static page is
  a thin client — this is why it's "not much harder": no model code moves client-side.
- **"Runs on HF too":** Hugging Face also hosts **static Spaces** (`sdk: static`), so the *same*
  static frontend can live on HF as well as GitHub Pages — satisfying "should be able to run on HF
  too" for the frontend, while the Gradio compute Space stays the backend.
- **Do NOT** attempt to port Demucs/transcription into the browser for the MVP; that was the WASM
  path we deferred. Keep the static page a pure client to the Space API.

### Dependency / environment risk register (real, from research)
- **numpy 2.0 is the dividing line.** Modern stack (librosa 0.11, pretty_midi, soundfile,
  torchcrepe) is fine. `ddsp` (TF) fights the whole env (numpy<1.24, Py 3.10 max, breaks on Apple
  Silicon) — **isolate it or avoid**; prefer `ddsp_pytorch`.
- **librosa 0.11 needs numba≥0.61 for numpy 2.1+** — else pin `numpy<2.1`.
- **torchaudio is in maintenance** (I/O migrating to torchcodec) — pin versions; use `soundfile`
  for I/O.
- **`dasp-pytorch` is git-only, last commit Dec 2023** — vendor / pin a SHA.
- **GPL/NC licenses to keep out of any shipped commercial path:** `pedalboard` (GPLv3 — SaaS ok,
  binary distribution not), YourMT3+/crepe-notes (GPL), LarsNet/ADTOF/IRMAS/MUSDB/MoisesDB (NC).
- Add `libsndfile1` + `ffmpeg` to `packages.txt`.

---

## Licensing — the one real commercial blocker (document, don't ignore)

All separation/transcription **code** is MIT/Apache/ISC-safe. **The risk is the model *weights*:**
BS-RoFormer / htdemucs usable weights are trained on **MUSDB18**, licensed *"for educational
purposes only… not for any commercial purpose."* MIT code does not launder non-commercial training
data. This is exactly why Moises/LALAL retrain on licensed/proprietary data.

**Decision (locked):** build the MVP as a **research / demo / educational tool** on HF Spaces using
the best open weights, **document this risk prominently**, and make **"retrain separation on
licensed data (or license a commercial engine)"** an **explicit gate before any monetization.**
Training on commercial music for shippable weights is legally unsettled (RIAA v. Suno/Udio, key
2026 hearing; label settlements late 2025) — **do not scrape commercial catalogs for shipped
weights.** The synthetic synth/effect dataset is clean (CC-BY, no copyright entanglement).

---

## What Fable should sequence (components + dependencies)

**Step 0 (do this first — makes the handoff permanent):** copy this plan and its six appendix
research reports **into the project directory** so they live with the code and survive a cleared
session — `cp ~/.claude/plans/mighty-yawning-thunder.md /Users/nakas/Documents/stemflipper/PLAN.md`
and `~/.claude/plans/mighty-yawning-thunder-agent-*.md` → `stemflipper/research/`. Then `git init`
the project and commit them as the first commit. (The small stray `-agent-*.md` stubs can be
skipped — see Appendix.)

Fable owns the ordering. Dependency facts to sequence around:
- **`analyze/` tempo+key** and **`separate/`** are independent front-end stages.
- **`transcribe/` must precede all `reconstruct/`** (MIDI drives slicing + fitting + labeling).
- **`analyze/` router must precede `reconstruct/`** (it picks the strategy per stem).
- Within reconstruct: **sampler path is the reliable baseline** (build first, it's every stem's
  fallback); **synth-fit and effects are the deepenable frontier stages** layered on top.
- **`export/` MVP bundle** (WAV + SMF Format-1 MIDI + manifest + SFZ + Reaper RPP) is the
  end-to-end payoff; **DAWproject is a phase-2 export** behind it.
- **`dataset/` generator** is independent of the app pipeline (parallel track) and publishes to HF.
- **Deployment** (`app.py` + Space config) can wrap the pipeline as soon as a thin slice exists.
- **`web/` static frontend** is a thin client to the Space API — build it *after* the Space is live
  (it just needs the Space URL / API). Cheap, parallelizable, non-blocking.
- **Phase 2 (out of this build):** train synth/effect estimators on the dataset; upgrade drums
  (ADT); Ableton `.als` export; the licensing/retrain gate before monetization; **(deferred) WASM /
  in-browser processing** for a faster/cheaper client-side path.

**Suggested (non-binding) first slice for a fastest proof-of-life:** upload → `separate` (htdemucs)
→ `transcribe` (basic-pitch) → `reconstruct` sampler (SFZ) → `export` bundle (WAV+MIDI+SFZ+RPP),
live on the Space — every stage present but simple — then deepen router → synth-fit → effects →
DAWproject, and run the `dataset/` track in parallel. Fable may reorder.

---

## Verification (how to know each stage works, end-to-end)

- **Separation:** run `audio-separator` on a known song; confirm N stem WAVs, sane loudness,
  audible separation. Spot-check htdemucs_6s piano-stem bleed (expected weak).
- **Transcription:** transcribe a stem → open the `.mid` in a DAW / `pretty_midi`; confirm notes
  align to audio. Sanity-check bass octave errors and drum GM mapping. Optionally score against a
  **Slakh2100** track with `mir_eval`.
- **Router:** feed a known mono synth lead, an acoustic guitar, and a piano chord stem; assert the
  router picks synth-fit / sampler / sampler-phrase respectively.
- **Sampler:** build an SFZ from a bass stem; **validate with `sfzlint`**; load in **sfizz** and
  play the MIDI — confirm it tracks the original.
- **Synth-fit:** fit a mono synth stem to Vital via Syntheon + CMA-ES; load the `.vital` preset and
  A/B against the stem; confirm FM/wavetable timbres are *flagged* rather than silently wrong.
- **Effects:** EQ-match a stem, apply via `pedalboard`, confirm spectral envelope moves toward
  target (auraloss decreases). Confirm reverb IR convolution sounds plausible.
- **Export:** open the MVP bundle's **Reaper `.RPP`** — tracks/tempo/items load; drag the SFZ onto
  a sampler; confirm MIDI plays. Phase 2: open `.dawproject` in Bitwig/Studio One.
- **Deployment:** deploy the Space; upload a 3–4 min song; confirm the job completes inside the
  ZeroGPU window with streamed progress and a downloadable bundle; check GPU-seconds/song ≈ target.
- **Static frontend:** publish `web/` to GitHub Pages (and/or an HF `sdk: static` Space); confirm it
  reaches the live Space (link/iframe, or a full round-trip via `@gradio/client`) and a real upload
  produces a downloadable bundle end-to-end through the static page.
- **Dataset:** generate a small torchsynth (audio, params) batch + a dasp (wet, params) batch;
  push a `datasets` repo to HF; confirm it loads via `datasets` and the generator reproduces audio
  deterministically from seeds.

---

## Appendix — full per-domain research reports (for Fable to mine)

Each research agent wrote a detailed, fully-cited report. Fable should read these for the exact
benchmark numbers, arXiv IDs, HF repo IDs, code snippets, and source URLs behind every claim above:
- **Source separation SOTA:** `mighty-yawning-thunder-agent-a5b76e6d6c6395dd7.md`
- **Audio→MIDI transcription:** `mighty-yawning-thunder-agent-a567b1347fdd2ef91.md`
- **Synth/timbre/effects reconstruction:** `mighty-yawning-thunder-agent-a698f884d324ef7fc.md`
  *(the most important single read; INSTRUMENTAL arXiv:2603.15905 ≈ StemFlipper prototype)*
- **DAW export / project formats:** `mighty-yawning-thunder-agent-a7ddadb6df240c3a9.md`
- **HF Spaces deployment:** `mighty-yawning-thunder-agent-a634de2bf318aaea0.md`
- **Datasets & training:** `mighty-yawning-thunder-agent-ab65c47206add3abe.md`

(All in `/Users/nakas/.claude/plans/`. A few short `-agent-*.md` stubs in that dir are scratch
fragments from sub-searches and can be ignored.)
