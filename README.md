---
title: StemFlipper
emoji: 🎛️
colorFrom: purple
colorTo: blue
sdk: gradio
sdk_version: 6.19.0
app_file: app.py
python_version: "3.10.13"
pinned: false
license: mit
short_description: Song → stems → MIDI → editable instruments → DAW bundle
---

# 🎛️ StemFlipper

Upload a song → AI source-separation into stems → each stem becomes **transcribed MIDI +
a playable sliced-sample instrument (SFZ)** → download a **DAW project bundle**.

**Try it:** [live web app](https://andrewnakas.github.io/stemflipper/) ·
[Hugging Face Space](https://huggingface.co/spaces/nakas/stemflipper) ·
[parameter dataset](https://huggingface.co/datasets/nakas/stemflipper-dataset)

The web app in [`web/`](web/) is a static, build-step-free page that calls the Space's
API via `@gradio/client`; it is served from GitHub Pages. What the bundle contains:

```
song/
  stems/*.wav          separated stems (htdemucs)
  midi/song.mid        multitrack SMF Format 1 (tempo map) + per-stem .mid
  instruments/*/*.sfz  sliced-sample instruments (load in sfizz / Sforzando / DecentSampler)
  project.RPP          Reaper project with the stems arranged at the right tempo
  manifest.json        tempo, key, stem→file map
  README.txt           how to import into any DAW
```

## Run locally

```bash
python3.10 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m stemflipper song.mp3 -o out/     # CLI
.venv/bin/python app.py                              # Gradio UI at :7860
.venv/bin/pytest -m "not slow"                       # tests
```

## Hardware notes

- **This Space runs on free CPU hardware** — separation of a 3–4 min song takes several
  minutes. The queue + progress bar handle it; just wait.
- **ZeroGPU upgrade path** (needs a PRO account): Space Settings → Hardware → ZeroGPU.
  The code is already compatible — `app.py` wraps only the separation stage in
  `@spaces.GPU(duration=180)`; everything else stays on CPU.

## Honest limitations (MVP)

- Transcription is an *editable starting point*, not a perfect score. Drums use an onset
  heuristic that misses overlapping hits.
- Sampler slices inherit any bleed/reverb baked into the separated stems.
- Separation weights (htdemucs) are trained on MUSDB18 (non-commercial training data) —
  this app is a **research/educational demo**, not a commercial service. See `PLAN.md`
  ("Licensing") for the retrain-before-monetization gate.

## Repo map

`stemflipper/` pipeline library (CLI: `python -m stemflipper`) · `app.py` Gradio adapter ·
`tests/` pytest suite with a deterministic synthetic test song · `PLAN.md` + `research/`
the research/architecture brief · `HANDOFF.md` build state, task queue, invariants ·
`dataset/`, `web/` upcoming (see HANDOFF.md).
