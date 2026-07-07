# Automatic Drum Transcription (ADT) — Research Report

Goal: convert a drum audio stem into a MIDI drum pattern (kick/snare/hihat timing) inside a Python web app (HuggingFace Spaces, CPU-first).

> Note: this is a **research deliverable**, not a code-change plan. The body below is the requested structured report. No code changes are proposed or required.

---

## TL;DR Recommendation

For a **CPU-first HuggingFace Space in 2026**, ranked by practicality:

1. **ADTOF-pytorch** (the PyTorch inference fork of MZehren/ADTOF) — best purpose-built ADT that installs on modern Python, PyTorch-only, trained on real music (not just drum solos). **License is CC BY-NC-SA 4.0 → non-commercial only.** Detects kick/snare/hihat + toms/cymbals. This is the strongest "real" ADT option.
2. **librosa onset-detection + spectral classifier fallback** — trivially installs, fast on CPU, permissive license (ISC/BSD). Accuracy is mediocre for anything but clean isolated hits, but it is a robust, always-works fallback and easy to ship. **Recommended as the guaranteed-working baseline.**
3. **ADTLib** — does exactly what you want (kick/snare/hihat → onsets) but is **effectively abandonware**: depends on TensorFlow 1.x + old madmom, will **not** `pip install` cleanly on Python 3.10+. Avoid unless you pin an old environment.
4. **madmom** — excellent for onset/beat/downbeat detection to *build* a simple ADT, but the PyPI release (0.16.1, 2018) does not install on Python 3.10+; you must build the `0.17.dev` git master with pre-installed Cython/NumPy. Models are **CC BY-NC-SA (non-commercial)**.
5. **omnizart drum** — CNN ADT with pretrained checkpoints, but TensorFlow 2.x heavy, historically fragile installs, and the drum model has acknowledged training bugs. Marginal on CPU Spaces.
6. **Magenta Onsets-and-Frames Drums (E-GMD)** — state-of-the-art quality **but drum-solo-only**, TensorFlow 1.15, repo **archived Jan 2026**. Abandonware for practical purposes.
7. **YourMT3+ / MT3** — transformer multi-instrument transcription incl. drums; real HF Spaces demos exist (incl. a CPU space). Heavy, GPU-oriented, drums are a secondary output. Overkill for a drum-only pattern.

**Practical build:** ship the librosa fallback as the always-available path, and optionally offer ADTOF-pytorch as the "high quality" path if the non-commercial license is acceptable for your app.

---

## 1. ADTLib (CarlSouthall/ADTLib)

- **Repo:** https://github.com/CarlSouthall/ADTLib · **PyPI:** `pip install ADTLib`
- **What it detects:** kick drum, snare drum, hi-hat onsets (3 classes only). Uses a pretrained bidirectional RNN (SA/DA models from the author's ISMIR research).
- **Output format:** a `.txt` file of onset times per instrument, plus an auto-generated **drum tablature PDF** (via `fpdf`). **No native MIDI export** — you would map the txt onsets to GM MIDI yourself.
- **CLI / API:**
  - CLI: `ADT Drum.wav`
  - Python: `from ADTLib import ADT`
- **Dependencies:** `numpy, scipy, madmom, tensorflow, fpdf`. It uses **TensorFlow 1.x** (pre-`tf.compat.v1` API, `tf.placeholder`/`tf.Session` style) and an **old madmom**. No version pins in setup, which makes resolution worse, not better.
- **Python compatibility:** **Broken on Python 3.10+.** Blockers: (a) TensorFlow 1.x has no wheels for Python ≥3.8; (b) madmom dependency itself won't build on 3.10+ from PyPI; (c) TF1-style graph code. Realistically needs Python 3.6/3.7 + TF 1.x in a frozen env.
- **License:** BSD (2-clause) — permissive, commercial-friendly (the code; models are the author's own weights, also permissive). This is the *one* nice thing vs. madmom/ADTOF.
- **Maintained?** No. **Abandonware** — no meaningful updates in years; last activity is old. Flag: will not install on a modern HF Space.
- **Verdict:** Does precisely the kick/snare/hihat task you want, but the TF1 + old-madmom stack makes it a non-starter on Python 3.10+ / HF Spaces without a legacy container. Skip.

Sources: https://github.com/CarlSouthall/ADTLib · https://github.com/CarlSouthall/ADTLib/blob/master/README.md · https://kandi.openweaver.com/python/CarlSouthall/ADTLib · https://samxan.wordpress.com/2017/10/22/notes-on-tensorflow-and-how-it-was-used-in-adtlib/

---

## 2. madmom (CPJKU/madmom)

- **Repo:** https://github.com/CPJKU/madmom · **PyPI:** https://pypi.org/project/madmom/ · **Docs:** https://madmom.readthedocs.io
- **Capabilities relevant to ADT:** strong **onset detection** (spectral flux, SuperFlux, RNN/CNN onset detectors), **beat & downbeat tracking** (RNN/DBN), tempo estimation, and note/piano transcription. **No dedicated drum-transcription model**, but it is the standard toolkit for the *onset + beat grid* half of a home-built ADT (detect onsets → classify each onset into kick/snare/hihat → quantize to beat grid → emit MIDI).
- **Latest PyPI release:** **0.16.1, released 14 Nov 2018.** Officially lists Python 2.7 / 3.5–3.7.
- **Python 3.10+ compatibility — the key problem:**
  - The **PyPI 0.16.1 wheel/sdist does not install on Python ≥3.10** (fails to build; also uses deprecated `np.int`/`np.float`). Tracked in issues #527, #535; users repeatedly report failures on 3.10/3.11/3.12 (#523, #528, #543).
  - The unreleased **`0.17.dev0`** git master fixes many issues (deprecated NumPy types replaced — PR #542, Dec 2024), but **has never been published to PyPI** (#543 is literally a plea to publish 0.17).
  - **Cython ordering bug (#463):** Cython must be installed *before* building madmom.
  - **NumPy ABI pinning (#485):** `ndarray size changed, may indicate binary incompatibility` errors when madmom is built against a different NumPy than runtime. Pin NumPy at build and run time.
- **Working install recipe on Python 3.10/3.11 (approx.):**
  ```
  pip install "numpy<2" cython scipy
  pip install "git+https://github.com/CPJKU/madmom.git"   # builds 0.17.dev0 from master
  ```
  (Success is version-sensitive; NumPy 1.x + matching Cython is the reliable combo. NumPy 2.x is risky.) Note the related project `CPJKU/beat_this` issue #9 explicitly documents that the *released* madmom requires Python ≤3.9 — reinforcing "use git master, not PyPI."
- **License:** **BSD** for code, but **pretrained models + data are CC BY-NC-SA 4.0 (non-commercial).** Commercial use of the beat/onset models requires contacting the authors. This matters for a shipped app.
- **Maintained?** Semi. The repo gets occasional fixes (2024 NumPy PR) but **no new PyPI release since 2018**; effectively low-maintenance / community-patched. Not dead, but not healthy.
- **Verdict:** Best building block for a DIY ADT (onset detection + beat grid). Installs on modern Python only from git master with NumPy/Cython pinned. Non-commercial model license is a real constraint. On CPU this is fast enough.

Sources: https://github.com/CPJKU/madmom · https://pypi.org/project/madmom/ · https://madmom.readthedocs.io/en/latest/installation.html · https://github.com/CPJKU/madmom/pull/542 · https://github.com/CPJKU/madmom/issues/543 · https://github.com/CPJKU/madmom/issues/485 · https://github.com/CPJKU/madmom/issues/463 · https://github.com/CPJKU/beat_this/issues/9

---

## 3. Neural ADT models (2020–2026)

### 3a. ADTOF / ADTOF-pytorch (MZehren) — **strongest practical neural ADT**
- **Repo:** https://github.com/MZehren/ADTOF · **Paper (ISMIR 2021):** https://arxiv.org/abs/2111.11737 · **Datasets:** https://zenodo.org/doi/10.5281/zenodo.10084510
- **What it is:** a CRNN drum transcriber trained on the **ADTOF dataset** (359 h of *real, non-synthetic* music annotated from rhythm-game charts). Trained on real mixes → generalizes to real music far better than drum-solo models.
- **Classes:** kick, snare, hi-hat, cymbals, toms (5-class; the "high-quality/reproducible" 2023 follow-up in *Signals* journal refines this and adds velocity). Maps cleanly to GM MIDI.
- **Install:** the main repo installs via `pip3 install .` from source (not a PyPI package) and traditionally pulled in TF/Keras/madmom. The README points to **`ADTOF-pytorch`**, described as the recommended inference path: **PyTorch-only (no TensorFlow, Keras, or madmom)**, with only ~-0.2% F-measure vs. the original. There's also a Colab and a local `bin/drumTranscriptor.ipynb`.
- **Pretrained models:** yes, included for inference (CPU-capable).
- **Python:** tested on 3.10 (macOS Ventura noted). PyTorch-only path is the modern-Python-friendly option.
- **License:** **CC BY-NC-SA 4.0 → non-commercial only.** This is the main blocker for commercial deployment.
- **Maintained?** Low commit count but the pytorch-inference path is the actively-recommended usage. Usable in 2026.
- **Verdict:** The best real-music ADT you can actually install on Python 3.10+ with just PyTorch (great for a CPU HF Space). Only caveat: non-commercial license. **Top pick if NC is acceptable.**

### 3b. Magenta Onsets-and-Frames "Drums" (E-GMD)
- **Model page:** https://magenta.tensorflow.org/oaf-drums · **Code:** https://github.com/magenta/magenta/tree/main/magenta/models/onsets_frames_transcription
- **What it does:** transcribes solo drum recordings to **MIDI with per-hit drum classification and velocity** — highest perceptual quality of the classic models.
- **E-GMD dataset:** ~444 h, GMD re-recorded on 43 kits. Great data, but the model is trained for **drum solos**, not full mixes / arbitrary stems.
- **Checkpoint:** `https://storage.googleapis.com/magentadata/models/onsets_frames_transcription/e-gmd_checkpoint.zip`
- **CLI:** `onsets_frames_transcription_transcribe --config=drums --model_dir=... file.wav`
- **Stack:** **TensorFlow 1.15** era. The `magenta` repo is **archived (read-only) as of Jan 2026** — the team moved to MT3.
- **License:** Apache-2.0 (code) — commercially permissive, unlike madmom/ADTOF. But the TF1 stack is the problem.
- **Verdict:** Excellent output quality on isolated drum stems, permissive license, but TF1 + archived repo = **abandonware** for practical Python 3.10+ CPU deployment. Hard to stand up on a modern Space.

### 3c. MT3 / YourMT3+ (transformer, multi-instrument incl. drums)
- **MT3:** https://github.com/magenta/mt3 · paper https://arxiv.org/abs/2111.03017 · HF Space https://huggingface.co/spaces/akhaliq/MT3
- **YourMT3+:** https://github.com/mimbres/YourMT3 · paper https://huggingface.co/papers/2407.04822 · Spaces: https://huggingface.co/spaces/mimbres/YourMT3 and **CPU variant** https://huggingface.co/spaces/mimbres/YourMT3-cpu · model collection https://huggingface.co/collections/mimbres/multi-instrument-automatic-music-transcription
- **Drums:** MT3 emits a General-MIDI drum token stream (128 GM drum types), but drums are explicitly a *secondary* output, "included for completeness." YourMT3+ (2024, T5-based, HF `transformers`) improves multi-instrument transcription and has PyTorch + HF Spaces demos, including a **CPU space** (proves CPU inference is feasible, though slow).
- **Stack:** MT3 uses JAX/T5X (heavy, GPU-oriented, notoriously finicky to install). YourMT3+ is PyTorch/PyTorch-Lightning + HF `transformers` (more modern, still heavy).
- **License:** MT3 code Apache-2.0. Check YourMT3+ repo/weights license before commercial use.
- **Verdict:** State-of-the-art and the CPU HF Space demonstrates feasibility, but this is **overkill for a drum-only pattern** and heavy for CPU-first. Consider only if you also want melodic/multi-instrument transcription.

### 3d. LarsNet (drum **source separation**, not transcription)
- **Repo:** https://github.com/polimi-ispl/larsnet · **Paper:** https://arxiv.org/abs/2312.09663 (2023)
- **What it is:** PyTorch U-Nets that **separate a drum mix into 5 stems** (kick, snare, toms, hi-hat, cymbals). It does **not** produce MIDI/onsets — it is a *pre-processing* aid: separate stems, then run onset detection per stem for cleaner per-instrument timing.
- **Models:** pretrained checkpoints (~562 MB) under **CC BY-NC 4.0 (non-commercial)**. Trained on StemGMD (1224 h).
- **Verdict:** Useful *upstream* of ADT (isolate hi-hat before onset detection → cleaner classification), not an ADT itself. Non-commercial, and 562 MB is heavy for a lightweight CPU Space.

### 3e. omnizart (drum module)
- **Repo:** https://github.com/Music-and-Culture-Technology-Lab/omnizart · **PyPI:** `pip install omnizart` · **Docs:** https://music-and-culture-technology-lab.github.io/omnizart-doc/drum/api.html
- **What it does:** general AMT toolbox (vocal, chord, beat, drum, instruments). Drum model = CNN (~9.4M params, 5 conv + attention + FC). `omnizart download-checkpoints`, then `omnizart drum transcribe file.wav`.
- **Known issue:** maintainers state the **drum model has unknown bugs preventing loss convergence when training from scratch** — inference with provided checkpoints works, but quality is uneven.
- **Stack:** **TensorFlow 2.x** heavy; historically painful dependency resolution. Python support tied to older TF2 versions; risky on 3.11/3.12.
- **License:** MIT (code) — permissive.
- **Verdict:** Installable-ish but heavy and fragile on CPU Spaces; drum quality is not its strength. Lower priority.

### 3f. Other 2024–2026 research (context, mostly not shippable packages)
- **Diffusion/generative ADT** and **transformer ADT** papers (e.g., "Towards Realistic Synthetic Data for ADT" arxiv 2601.09520; momentum-based ADT arxiv 2507.12596; STRUM rhythm-game charting arxiv 2605.12135) exist but are **research code**, not turnkey pip packages.
- **STAR Drums** — a newer ADT dataset (https://transactions.ismir.net/articles/10.5334/tismir.244), dataset not a model.
- **No single dominant, permissively-licensed, pip-installable pretrained drum-transcription model** has emerged as a clear standard as of mid-2026. ADTOF-pytorch remains the most practical purpose-built option.

Sources: https://github.com/MZehren/ADTOF · https://arxiv.org/abs/2111.11737 · https://www.mdpi.com/2624-6120/4/4/42 · https://zenodo.org/doi/10.5281/zenodo.10084510 · https://magenta.tensorflow.org/oaf-drums · https://github.com/magenta/magenta/blob/main/magenta/models/onsets_frames_transcription/README.md · https://github.com/magenta/mt3 · https://github.com/mimbres/YourMT3 · https://huggingface.co/spaces/mimbres/YourMT3-cpu · https://github.com/polimi-ispl/larsnet · https://arxiv.org/abs/2312.09663 · https://github.com/Music-and-Culture-Technology-Lab/omnizart

---

## 4. Simple onset-detection fallback (librosa) — the always-works path

**Approach:** onset detection → per-onset feature extraction → classify into kick/snare/hihat → map to GM MIDI note → write MIDI.

- **Install (permissive, trivial, CPU-fast):**
  ```
  pip install librosa numpy scipy mido    # or pretty_midi for MIDI writing
  ```
  librosa is **ISC-licensed** (BSD-like, commercial-friendly); installs cleanly on Python 3.10/3.11/3.12.
- **Onset detection:** `librosa.onset.onset_detect()` / `onset_strength()` (docs: https://librosa.org/doc/main/onset.html). Optionally HPSS (`librosa.effects.hpss`) to emphasize percussive content first.
- **Classification of each onset** — two viable strategies:
  1. **Heuristic / unsupervised (no model):** cut a short window after each onset; compute **spectral centroid**, spectral bandwidth/rolloff, zero-crossing rate, and low-band energy. Rules of thumb: **kick** = dominant low-frequency energy / low centroid; **snare** = mid-band + noisy (high ZCR, broadband); **hi-hat** = high centroid + high ZCR + short decay. Cluster (e.g., k-means) or threshold. This is what tutorials like soundsandwords.io and the `drumsep` project do.
  2. **Small trained classifier:** train a lightweight CNN/MLP on MDB-Drums / E-GMD hit windows for kick/snare/hihat. Better accuracy, still CPU-cheap at inference.
- **Is it viable as a fallback?** **Yes — as a fallback, not as a primary.** Honest accuracy assessment:
  - Works well on **clean, isolated, non-overlapping** drum hits (a real drum *stem* helps a lot vs. a full mix).
  - Struggles with **simultaneous hits** (kick+hihat together), **overlapping decays**, ghost notes, and dense fills — it cannot separate two instruments firing on the same onset frame. Neural ADT (ADTOF) handles polyphony; this heuristic largely does not.
  - Expect roughly "usable groove skeleton" quality, materially below neural ADT F-scores, but **it always installs and always runs on CPU**, with a permissive license and no NC restriction. That combination is why it's the recommended guaranteed baseline.
- **Related pure-Python helper:** `cukas/drumsep` (https://github.com/cukas/drumsep) separates drums into kick/snare/hihat/cymbals/toms using HPSS + frequency masking + transient detection, **no ML** — handy reference for the heuristic classifier.

Sources: https://librosa.org/doc/main/onset.html · https://www.soundsandwords.io/drum-sound-classification/ · https://github.com/cukas/drumsep · https://towardsai.net/p/l/building-an-audio-classification-model-for-automatic-drum-transcription-heres-what-i-learnt

---

## 5. Mapping to the MIDI drum map (General MIDI percussion, Channel 10)

Standard GM note numbers for the pieces you care about (put all drum events on **MIDI channel 10 / index 9**):

| Drum piece | GM MIDI note |
|---|---|
| Acoustic Bass Drum (kick) | **35** |
| Bass Drum 1 (kick) | **36** |
| Side Stick / Rimshot | 37 |
| Acoustic Snare | **38** |
| Hand Clap | 39 |
| Electric Snare | 40 |
| Low Floor Tom | 41 |
| **Closed Hi-Hat** | **42** |
| High Floor Tom | 43 |
| Pedal Hi-Hat | 44 |
| Low Tom | 45 |
| **Open Hi-Hat** | **46** |
| Low-Mid Tom | 47 |
| Hi-Mid Tom | 48 |
| Crash Cymbal 1 | 49 |
| High Tom | 50 |
| Ride Cymbal 1 | 51 |
| Crash Cymbal 2 | 57 |
| Ride Cymbal 2 | 59 |
| Cowbell | 56 |

**For a minimal kick/snare/hihat ADT, map to: kick → 36, snare → 38, closed hi-hat → 42** (open hi-hat → 46 if you distinguish it).

> One correction vs. some web tables: **side stick/rimshot = 37**, and **hand clap = 39** (not 40). Snare is 38 (acoustic) / 40 (electric).

**Writing the MIDI:** use `pretty_midi` (create an `Instrument(program=0, is_drum=True)`, add `Note(pitch=36, start=t, end=t+0.05, velocity=v)`) or `mido` (emit `note_on`/`note_off` on channel 9). `pretty_midi` is easiest and CPU-trivial.

Source: https://en.wikipedia.org/wiki/General_MIDI (GM Percussion Key Map)

---

## Install / license / compatibility cheat-sheet

| Option | Install (2026, Py 3.10+) | License | CPU / Spaces | Honest quality | Flag |
|---|---|---|---|---|---|
| **librosa fallback** | `pip install librosa scipy mido pretty_midi` | ISC / BSD (permissive) | ✅ fast | Baseline; poor on overlaps | Recommended baseline |
| **ADTOF-pytorch** | `pip install .` from git (PyTorch only) | **CC BY-NC-SA 4.0 (NC)** | ✅ works on CPU | Best real-music ADT | NC license only |
| **madmom** (onsets/beats) | `pip install "numpy<2" cython`; `pip install git+https://github.com/CPJKU/madmom.git` | BSD code / **NC models** | ✅ | Great onset+beat grid, no drum model | PyPI 0.16.1 won't install on 3.10+; use git master |
| **ADTLib** | (only Py3.6/3.7 + TF1) | BSD (permissive) | ❌ | Does k/s/hh, but unusable stack | **Abandonware — won't install 3.10+** |
| **omnizart drum** | `pip install omnizart` (TF2) | MIT | ⚠️ heavy/fragile | Mediocre, known drum bugs | Fragile TF2 deps |
| **Magenta OaF Drums** | TF1.15 legacy env | Apache-2.0 | ❌ | Excellent on drum *solos* | **Repo archived Jan 2026, TF1** |
| **MT3 / YourMT3+** | JAX/T5X or PyTorch (heavy) | Apache-2.0 (MT3) | ⚠️ CPU space exists but slow | SOTA multi-instrument | Overkill for drums-only |
| **LarsNet** (separation, not ADT) | `pip install` from git (PyTorch) | **CC BY-NC 4.0 (NC)** | ⚠️ 562 MB | Great stem separation (pre-step) | Not a transcriber; NC |

**Abandonware / won't-install-on-3.10+ flags:** ADTLib (TF1 + old madmom), Magenta Onsets-and-Frames Drums (TF1.15, archived), madmom's *PyPI release* (0.16.1 only builds ≤3.9 — must use git master).

---

## Suggested implementation shape (for later, once out of plan mode)

1. **Baseline path (always on):** librosa onset detection on the drum stem (optionally HPSS-preprocessed) → per-onset spectral features → kick/snare/hihat heuristic (or small trained classifier) → quantize to a beat grid (madmom beat tracker if available, else librosa) → `pretty_midi` drum track (notes 36/38/42 on channel 9). Permissive, CPU-cheap, guaranteed to run on a Space.
2. **Optional "HQ" path (if NC license OK):** ADTOF-pytorch inference → map its 5 classes to GM notes → same MIDI writer.
3. Keep the neural path behind a feature flag / try-except so the Space never hard-fails if the model/env is unavailable.

(No code has been written; this is the plan/report only.)
