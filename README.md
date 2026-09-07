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
short_description: Song → stems → MIDI + samples → editable instruments
---

# 🎛️ StemFlipper

Upload a song. It is separated into stems — and the drum kit into its own kick, snare,
toms, hi-hat, ride and crash — then each stem is transcribed to **MIDI** and cut into
**samples**: drum one-shots with velocity layers and round robins, pitch-verified
multisamples, bar-aligned loops, vocal phrase chops. You get a bundle any DAW or sampler
can open, plus a web editor that plays **the original stems against the reconstruction**
so you can blend them, fix the notes, and export.

**Try it:** [web editor](https://andrewnakas.github.io/stemflipper/app.html?fixture=ci) ·
[Hugging Face Space](https://huggingface.co/spaces/nakas/stemflipper) ·
[parameter dataset](https://huggingface.co/datasets/nakas/stemflipper-dataset)

## What you get

```
song/
  project.json          the whole song described: grid, chords, per-track notes,
                        which engine transcribed what, and where every asset lives
  stems/*.flac          separated stems (24-bit); stems/drums/ holds the split kit
  midi/song.mid         multitrack MIDI: tempo map, time signature, section markers,
                        chord track, drums on channel 10 (+ per-stem .mid)
  instruments/<stem>/   a playable instrument built from this song's own audio
                          kit.json / instrument.json   the web editor's sampler
                          *.sfz                        sfizz, Sforzando, DecentSampler
                          *.dspreset                   DecentSampler (free, all platforms)
                          *.vital                      Vital patch for synth-like stems
                          samples/                     the extracted one-shots
  loops/*.wav           bar-aligned loops cut at real downbeats, named with tempo and key
  phrases/*.wav         silence-bounded vocal chops, labelled by pitch range
  effects/*.json        measured EQ curve and reverb time per stem
  project.dawproject    open project format: Bitwig 5+, Studio One 6.5+, Cubase 14+
```

## How it works

**Separation is a chain, not one model.** There is no 4-stem RoFormer, so the quality
presets stack the best available pieces:

| preset | chain |
|---|---|
| `fast` | htdemucs |
| `balanced` | RoFormer vocals → htdemucs → drum-kit split |
| `best` | RoFormer vocals → htdemucs_ft → drum-kit split |

Splitting the kit is also what makes drum transcription accurate: a kick and a hat in the
same 10 ms are two onsets in two separate signals. On the test fixture that takes drum
recall from 64/96 to 94/96, with hi-hats going from 35/64 to 64/64 — without any
non-commercially-licensed drum model.

**Transcription picks an engine per stem** and checks the answer: monophonic pitch
tracking for bass and lead vocals (cross-checked against basic-pitch, with an octave sanity
check), the ByteDance model for piano, per-piece onsets for drums, basic-pitch elsewhere.
Every stage records whether it succeeded, fell back or failed, and that trail ships in
`project.json`.

## Run locally

```bash
uv venv --python 3.10 .venv                          # or: python3.10 -m venv .venv
uv pip install --python .venv/bin/python -r requirements.txt -r requirements-dev.txt
.venv/bin/python -m stemflipper song.mp3 -o out/ --preset best
.venv/bin/python app.py                              # backend at :7860
.venv/bin/python -m pytest -m "not slow"

cd web && npm ci && npm run dev                      # the editor
```

The editor talks to whichever backend you point it at, so `python app.py` locally avoids
the hosted GPU queue entirely.

## Hardware and quota

The Space runs on **ZeroGPU**. All neural work happens in one GPU call per song whose
length is estimated from the song and preset. Hugging Face gives **anonymous API callers
2 GPU-minutes a day**, so the editor has a field for your own HF token — with one, GPU
time is billed to your account instead of the shared pool.

## Honest limitations

- Transcription is an **editable starting point**, not a finished score. Drums are the
  most accurate part; dense polyphony in `other` is the least.
- Samples inherit whatever bleed and reverb the separation left in the stem.
- The Vital patch and the EQ/reverb match approximate the sound; they do not recreate the
  original signal chain.
- Separation weights are trained on MUSDB18 (non-commercial training data), so this is a
  **research/educational demo**, not a commercial service. See `PLAN.md` ("Licensing").

## Repo map

`stemflipper/` the pipeline (`python -m stemflipper`) · `app.py` the Gradio backend ·
`web/` the Vite + TypeScript editor · `tests/` pytest with a deterministic synthetic song ·
`PLAN_V2.md` the current build plan · `HANDOFF.md` build state and invariants ·
`dataset/` the synthetic parameter-dataset generator.
