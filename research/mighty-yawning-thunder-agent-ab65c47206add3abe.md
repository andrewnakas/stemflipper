# StemFlipper — Datasets & Model-Training Research Report

Research on building a dataset (and possibly training models) for a web app that separates songs into stems, transcribes to MIDI, and reconstructs editable synth/instrument/effect chains. Hosted target: Hugging Face.

This is a research deliverable, not an implementation plan to execute.

---

## TL;DR

- **The audio → stems → MIDI → instrument-label** pipeline is fully served by existing datasets and pretrained models. You do **not** need to train anything for an MVP here.
- **Slakh2100** is the single most valuable existing dataset for you: it pairs mixture audio + isolated stem audio + aligned MIDI + instrument-class labels for 2,100 tracks. CC-BY-4.0, on HF Hub.
- **The synth-patch-params + effect-chain-params layer is a genuine public-data gap.** No dataset pairs real recorded audio with the synth patch / plugin parameters that produced it. This is the ambitious, novel contribution — and the only place synthetic-data generation (render known params → audio) is the right answer. **torchsynth/synth1B1** and **NSynth** are your starting points.
- **MVP = pretrained models glued together** (Demucs + a transcriber + a rule-based instrument mapper). **Research contribution = a synthetic (audio → synth/effect params) dataset + estimator.**

---

## 1. Existing multitrack / stem datasets

| Dataset | Content | Size | Audio? | MIDI? | Instr. labels? | License | HF / source |
|---|---|---|---|---|---|---|---|
| **MUSDB18 / MUSDB18-HQ** | Mixtures + 4 stems (vocals/drums/bass/other) | 150 songs (100 train / 50 test), ~10h | Yes | No | Stem-level only | Educational/non-commercial (46 tracks CC BY-NC-SA 4.0 from MedleyDB, 2 CC BY-NC-SA 3.0) | Zenodo DOI 10.5281/zenodo.1117372 (HQ: .../3338373) |
| **Slakh2100** ★ | Mixtures + per-source stems + aligned MIDI, synthesized from Lakh MIDI via sample-based virtual instruments | 2,100 tracks, 145h; 187 patches / 34 classes; splits 1500/375/225 | Yes | **Yes (aligned)** | **Yes (34 classes)** | **CC-BY-4.0** | HF: `Higobeatz/slakh2100` (~96 GB), `DreamyWanderer/Slakh2100-FLAC-Redux-Reduced`, `tvergho/slakh`; Zenodo 4599666; slakh.com |
| **BabySlakh** | Mini Slakh, first 20 tracks @ 16kHz | 20 tracks | Yes | Yes | Yes | CC-BY-4.0 | via slakh.com / mirdata |
| **Slakh2100-redux** | Deduplicated Slakh (originals had cross-split MIDI dupes) | 1,710 multitracks | Yes | Yes | Yes | CC-BY-4.0 | slakh.com |
| **Flakh2100** | Same MIDI rendered w/ FluidSynth + TimGM6mb.sf2 | 2,100 | Yes | Yes | Yes | CC-BY-4.0 | slakh.com |
| **MedleyDB** | Annotated royalty-free multitracks (melody/instrument annotations) | ~122 (v1) + v2 | Yes | No (pitch/melody annot.) | Yes (instrument activations) | CC BY-NC-SA | medleydb.weebly.com |
| **MoisesDB** | Multitrack w/ 2-level hierarchical stem taxonomy (3–10 stems/song), beyond 4-stems | 240 songs, 47 artists, 12 genres, ~14.5h | Yes | No | Yes (stem taxonomy) | **CC BY-NC-SA 4.0 (non-commercial research only)** | HF: `wearemusicai/moisesdb`; GitHub `moises-ai/moises-db` |
| **MAESTRO v3** | Virtuoso piano, audio + MIDI aligned to ~3ms | ~200h, ~1,276 performances | Yes | **Yes** | Piano only | CC BY-NC-SA 4.0 | magenta.tensorflow.org/datasets/maestro |
| **GuitarSet** | Solo guitar w/ rich annotations (pitch, string/fret, chords) | 360 excerpts | Yes | Note annot. (jams) | Guitar only | CC-BY-4.0 | Zenodo 3371780; GitHub `marl/GuitarSet` |
| **URMP** | Multi-instrument classical ensembles, separate tracks + score MIDI + video | 44 pieces | Yes | **Yes (score)** | Yes | CC (Dryad) | labsites.rochester.edu/air/projects/URMP |
| **E-GMD** | Human drum performances, audio annotated w/ MIDI (incl. velocity) | 444h, 43 drum kits | Yes | **Yes** | Drums only | CC-BY-4.0 | magenta.withgoogle.com/datasets/e-gmd |
| **NSynth** | Isolated monophonic single notes, 1,006 instruments, 11 families | 305,979 notes @16kHz, 4s | Yes | No (pitch/vel/instr metadata) | **Yes (fine-grained)** | CC-BY-4.0 | HF: `jg583/NSynth`; magenta |
| **Lakh MIDI (LMD)** | MIDI only (LMD-full / matched / aligned) | 176,581 files; 45,129 matched to MSD | No | **Yes** | Program-number | CC-BY-4.0 | colinraffel.com/projects/lmd |

**Which pair audio + MIDI + instrument labels (the StemFlipper core):**
- **Full pairing (audio ↔ stems ↔ MIDI ↔ instrument):** **Slakh2100** (+ Baby/Redux/Flakh variants). This is the crown jewel for you — but note it's *synthesized* from MIDI, so timbres are sample-library instruments, not the wild variety of commercial productions.
- **Single-instrument audio↔MIDI:** MAESTRO (piano), E-GMD (drums), GuitarSet (guitar), URMP (classical ensembles).
- **Audio + stems, no MIDI:** MUSDB18(-HQ), MoisesDB, MedleyDB — best for *separation* training/eval.
- **Instrument-labeled note audio (no context):** NSynth.
- **MIDI-only (symbolic modeling / rendering source):** Lakh MIDI.

**None of them include synth patch parameters or effect-chain parameters.** That layer does not exist publicly in any of these.

---

## 2. The synth / effect params gap (the hard part)

**Confirmed gap:** No public dataset pairs *real recorded audio* with the *synth patch parameters* and *effect-chain parameters* that produced it. Commercial productions don't ship their patches, and DAW sessions are proprietary. This is StemFlipper's genuinely novel territory.

The established workaround is **synthetic / self-supervised generation**: render audio *from known parameters* so the labels are free and exact. Prior art:

### Synth parameter estimation (audio → synth patch)
- **torchsynth / synth1B1** (Turian et al., ISMIR 2021, arXiv:2104.12922): GPU-optional modular synth in PyTorch, 16,200× real-time. Generates **1 billion 4-second sounds**, each returned *with the latent synthesis parameters* — explicitly "useful for multi-modal training regimes." Generated **on the fly** (not a download), deterministic/reproducible (synth1B1-312-6 addressing; synth1M1/synth10M1 subsets; 1/10 held out as test). This is the canonical "infinite labeled (audio, params) dataset." `synth1K1` is a small fixed eval set.
- **InverSynth** (Barkan et al., 2019, arXiv:1812.06349): CNN on spectrograms/raw audio → synth params (FM oscillators + envelope + gater). The foundational "deep synth parameter estimation" paper.
- **Synthesizer Sound Matching Using Audio Spectrogram Transformers** (2024, arXiv:2407.16643): AST regresses params; trained on ~1M–2.5M synthetic (params, one-shot) pairs, 16-param sets. Shows transformers beat MLP/CNN baselines. Good architecture template.
- **Approximately-equivariant flow matching for synth inversion** (2025, arXiv:2506.07199): handles parameter-space symmetries.
- **Neural Proxies for Sound Synthesizers** (2025, arXiv:2509.07635): perceptually-informed preset representations.
- **DDSP** (Engel et al., ICLR 2020): differentiable oscillators/filters/reverb; learns interpretable frame-wise synthesis params, small data. **MIDI-DDSP** (2022) does MIDI→audio with interpretable controls. Relevant if you go the differentiable-renderer route (params are learnable end-to-end rather than regressed).
- **Real software synths as renderers:** Dexed (DX7/FM, open), Surge XT (open), Vital (freemium wavetable) are commonly used to generate (patch → audio) corpora. Serum appears in the literature but is commercial. You choose an open synth, sample its parameter space, render → instant labeled dataset.

### Effect parameter estimation (audio → effect chain)
- **Blind estimation of audio effects via autoencoder + DDSP** (2023, arXiv:2310.11781): jointly estimates a whole chain — EQ + compressor + clipper.
- **Style Transfer of Audio Effects with Differentiable Signal Processing** (Steinmetz et al., 2022, arXiv:2207.08759): differentiable effect chain, matches a reference's effect style. (Steinmetz's `dasp-pytorch` / `micro-tcn` / `pyloudnorm` ecosystem is the practical toolkit.)
- **Differentiable Artificial Reverberation** (2021/2022, arXiv:2105.13940): estimates reverb params; solves the IIR-in-autodiff bottleneck with FIR frequency-sampling.
- **Automatic Multitrack Mixing w/ Differentiable Mixing Console** (2020/2021): neural channel proxies enable end-to-end mixing without ground-truth params.

**Takeaway:** For synth params and effect params, the viable path is **synthetic data with known parameters** (render forward, learn the inverse) and/or **differentiable renderers** (backprop a loss to params). torchsynth is the ready-made engine for synth; the effect side you'd build from open plugins + DSP libraries.

---

## 3. Training feasibility — train vs. off-the-shelf

**Use off-the-shelf (do NOT train):**
- **Source separation:** Demucs v4 / **Hybrid Transformer Demucs (htdemucs, htdemucs_ft, htdemucs_6s)** — SOTA, pretrained, on HF (`StemSplitio/htdemucs-ft-pytorch`, `Intel/demucs-openvino`, `mlx-community/demucs-mlx`) and via `pip install demucs`. Fine-tuning is possible on MUSDB18-HQ/MoisesDB but yields marginal gains for large effort/GPU cost; skip for MVP.
- **Transcription:** **Spotify basic-pitch** (`spotify/basic-pitch`, lightweight, instrument-agnostic, polyphonic + pitch bends, pip/npm) for a fast general transcriber; **MT3 / YourMT3(+)** (`arXiv:2111.03017`, `2407.04822`) for multi-instrument transcription (heavier, T5-based, trained partly on Slakh); MAESTRO-trained piano models; E-GMD drum transcription for drums.
- **Instrument labeling:** rule-based mapping from transcriber output / GM program numbers, or an NSynth-trained classifier.

**Reasonable to train (the differentiators):**
- **Synth-param estimator** — the highest-value custom model. Train on **torchsynth/synth1B1** (infinite free labels) or your own open-synth renders (Dexed/Surge/Vital). Architecture: spectrogram → CNN or AST → param regression (per arXiv:2407.16643). Feasible on a single modern GPU; you control dataset size, so scale to budget (1M–10M pairs is plenty to start).
- **Effect-param estimator** — train on synthetically FX-processed audio (clean stem → apply known EQ/comp/reverb params → learn inverse), following arXiv:2310.11781 / 2207.08759. Or use differentiable effects (`dasp-pytorch`) and skip a separate dataset.

**Compute ballpark:**
- Demucs full retrain: expensive (multi-GPU-days); **avoid.**
- Synth-param estimator from scratch on synthetic data: single-GPU, hours-to-days depending on scale — very tractable, and torchsynth generates data on-GPU on the fly so there's no storage bottleneck.
- basic-pitch-scale transcriber: also single-GPU tractable, but no need — use the pretrained one.
- HF free/community GPUs (Spaces ZeroGPU, AutoTrain) suit inference + light training; serious training wants your own/cloud A100/H100 or a rented GPU.

---

## 4. Hugging Face ecosystem

**Dataset hosting & streaming (audio):**
- **AudioFolder** builder: no-code dataset from a folder of audio + metadata.csv. Good up to a few thousand files.
- **Parquet:** recommended for small clips (<1MB each); HF auto-converts datasets ≤5GB to Parquet and serves the dataset viewer.
- **WebDataset (TAR shards, ~1GB each):** the right format for *big* audio corpora (Slakh-scale); loads in streaming mode. Slakh on HF (`Higobeatz/slakh2100`, ~96GB) uses WebDataset-style tar sharding.
- **Streaming (`streaming=True` / `IterableDataset`):** iterate without downloading the whole set — essential for 96GB Slakh or a large synthetic corpus. HF's 2025 "streaming datasets" improvements make this efficient for training loops.
- For a **synthetic** synth-param dataset, you often don't host audio at all — you host the **parameter seeds + a generator script** (torchsynth reproduces audio deterministically), which is tiny. That sidesteps storage/copyright entirely.

**Compute / training:**
- **HF AutoTrain** supports audio classification and some audio tasks — usable for an NSynth-style instrument classifier, less so for bespoke param-regression.
- **HF Spaces (Gradio/ZeroGPU)** — ideal for the StemFlipper demo front-end and inference (Demucs/basic-pitch spaces already exist, e.g. `Thafx/Demucs_v4_2s_HT`).
- **Model hosting:** push your trained synth/effect estimators as HF models; use `transformers`/`safetensors`.

**Relevant existing HF models per subtask:**
- Separation: `StemSplitio/htdemucs-ft-pytorch`, `Intel/demucs-openvino`, `monetjoe/hdemucs_high_musdbhq`, `mlx-community/demucs-mlx`.
- Transcription: `spotify/basic-pitch`; MT3/YourMT3+ (papers + code).
- Instrument/notes datasets: `jg583/NSynth`, `DynamicSuperb/InstrumentClassification_Nsynth`.
- Multitrack: `Higobeatz/slakh2100`, `DreamyWanderer/Slakh2100-FLAC-Redux-Reduced`, `wearemusicai/moisesdb`.
- Synth params: no canonical HF model yet — **this is open space** (generate with torchsynth, publish the estimator).

---

## 5. Data pipeline / bootstrapping strategy

**A. Supervised backbone (free, licensed, ready):**
- Use **Slakh2100** for supervised audio↔stems↔MIDI↔instrument. It's your ground-truth for the separation→transcription→labeling chain and for evaluating end-to-end reconstruction.
- Add MAESTRO (piano), E-GMD (drums), GuitarSet, URMP for per-instrument transcription depth.

**B. Weak-label bootstrapping (for scale / real timbres):**
- Run **Demucs → basic-pitch/MT3 → instrument mapper** over a corpus of songs to produce *weak* (audio, stems, MIDI, labels) pseudo-labels. These are noisy but scale cheaply and capture real production timbres Slakh lacks. Use for pretraining/augmentation, validate against Slakh's clean labels. (Watch copyright — see below.)

**C. Synthetic synth/effect params (the novel dataset):**
- **Synth:** generate with **torchsynth/synth1B1** (params returned free) and/or render open synths (Dexed/Surge/Vital) over sampled parameter grids → (audio, params). Train the estimator here.
- **Effects:** take clean stems (from Slakh or dry NSynth/DDSP renders), apply known EQ/comp/reverb/distortion chains with sampled params (via `dasp-pytorch` or plugin hosts) → (wet audio, effect params). Train the effect estimator here.
- Publish the **generator + parameter seeds** on HF rather than terabytes of audio.

**D. Copyright considerations (be careful):**
- MUSDB18 and MoisesDB are **non-commercial research only** (MoisesDB: CC BY-NC-SA 4.0, no derivatives, redistribution only via moises.ai). MedleyDB is CC BY-NC-SA. You **cannot** ship a commercial product trained on these under their terms — fine for research/eval, not for a commercial model weight release.
- Slakh, Lakh, NSynth, GuitarSet, E-GMD are **CC-BY-4.0** → commercially usable with attribution. Prefer these for anything you might monetize.
- Training on **commercial music** is legally unsettled: the **RIAA v. Suno/Udio** suits (filed 2024) turn on whether music-model training is fair use; a key **fair-use hearing was set for July 2026**, and several labels have **settled** (UMG/Warner with Udio; Warner with Suno) rather than litigate — signaling licensing, not free scraping, is the emerging norm. **Do not scrape commercial catalogs to train shippable weights.** For weak-label bootstrapping, use CC/royalty-free or your own licensed audio.

---

## 6. Realistic MVP recommendation

**Is training needed for an MVP? No.** The MVP is **pretrained models glued together**:

1. **Separate** with Demucs v4 (htdemucs_ft) → stems.
2. **Transcribe** each stem with basic-pitch (fast) or MT3/YourMT3+ (multi-instrument accuracy) → MIDI.
3. **Label** instruments via GM-program / stem-type mapping (optionally an NSynth-trained classifier).
4. **Reconstruct** by mapping each MIDI track to a default synth/instrument preset in your engine — **rule-based, not learned** for v1. Effects: start with sane defaults or simple heuristic matching.

Ship this. It already delivers "song → stems → MIDI → editable instrument tracks."

**Minimal viable *dataset* contribution (do this alongside MVP):**
- A **synthetic (audio → synth params) dataset** built with torchsynth or an open synth (Dexed/Surge/Vital), published on HF as generator + seeds (CC-BY, no copyright issues). Even 1–5M pairs is a citable, useful public artifact and directly powers your first learned differentiator.

**Ambitious research contribution (the moat):**
- A **learned synth-patch estimator** and **effect-chain estimator** that turn "default preset reconstruction" into "sounds like the original" — closing the params gap no public dataset addresses. Optionally, a small **hand-annotated (real audio → patch/effect params)** eval set (even a few hundred examples) would be a genuinely novel public benchmark, since none exists.

**Bottom line:** MVP = zero training, all pretrained glue. The dataset/training investment should go **entirely into the synth/effect-parameter layer**, using synthetic data — because that's the one part of StemFlipper the world hasn't already built.

---

## Key links / IDs
- Slakh: slakh.com · Zenodo 4599666 · HF `Higobeatz/slakh2100`, `DreamyWanderer/Slakh2100-FLAC-Redux-Reduced`, `tvergho/slakh` · arXiv:1909.08494 (Slakh paper)
- MUSDB18: Zenodo 1117372 / HQ 3338373 · sigsep.github.io/datasets/musdb.html
- MoisesDB: HF `wearemusicai/moisesdb` · GitHub `moises-ai/moises-db` · arXiv:2307.15913 (CC BY-NC-SA 4.0)
- MedleyDB: medleydb.weebly.com
- MAESTRO: magenta.tensorflow.org/datasets/maestro (v3)
- GuitarSet: Zenodo 3371780 · GitHub `marl/GuitarSet`
- URMP: labsites.rochester.edu/air/projects/URMP
- E-GMD: magenta.withgoogle.com/datasets/e-gmd · arXiv:2004.00188
- NSynth: HF `jg583/NSynth` · magenta.tensorflow.org/datasets/nsynth
- Lakh MIDI: colinraffel.com/projects/lmd
- torchsynth/synth1B1: GitHub `torchsynth/torchsynth` · arXiv:2104.12922 · docs synth1B1
- InverSynth: arXiv:1812.06349 · Synth sound matching (AST): arXiv:2407.16643
- DDSP: magenta.withgoogle.com/ddsp · ICLR 2020 · MIDI-DDSP (2022)
- Effect estimation: arXiv:2310.11781 (blind FX chain), 2207.08759 (FX style transfer), 2105.13940 (diff. reverb)
- Demucs: GitHub `facebookresearch/demucs` · HF `StemSplitio/htdemucs-ft-pytorch`
- basic-pitch: HF `spotify/basic-pitch` · GitHub `spotify/basic-pitch`
- MT3 / YourMT3+: arXiv:2111.03017 · arXiv:2407.04822
- HF audio datasets/streaming: huggingface.co/docs/datasets/audio_dataset · blog/streaming-datasets · datasets-webdataset
- Copyright: RIAA v. Suno/Udio (fair-use hearing ~July 2026; partial label settlements 2025)
