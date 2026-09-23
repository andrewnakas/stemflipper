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

Drop a song. It comes back split into stems, each transcribed to **MIDI**, with a web
editor that plays **the original stems against the reconstruction** so you can blend them,
fix the notes and export.

**You choose where it runs.**

| | in your browser | on the server |
|---|---|---|
| stems | vocals + instrumental | vocals, drums, bass, other — and the kit split into kick, snare, toms, hi-hat, ride, crash |
| MIDI | yes | yes, with a tempo map and section markers |
| samples, instruments, loops | — | drum one-shots with velocity layers and round robins, pitch-verified multisamples, bar-aligned loops, vocal chops |
| uploads your song | no | yes, deleted within 6 hours |
| limit | none | free GPU time, rationed per day |
| speed (3:30 song) | ~4 min on a GPU, much slower without | ~1 min |

The in-browser path exists because the shared GPU pool is two minutes a day across
*everyone* who is not signed in. It runs UVR-MDX-NET and basic-pitch through
onnxruntime-web, prefers WebGPU, and caches the 64 MB separation model so only the first
run pays for it.

**Use it:** [audiosaw.com/stemflipper](https://audiosaw.com/stemflipper/) ·
[hear an example](https://audiosaw.com/stemflipper/?fixture=demo) ·
[Hugging Face Space](https://huggingface.co/spaces/nakas/stemflipper) ·
[parameter dataset](https://huggingface.co/datasets/nakas/stemflipper-dataset)

The site is a static app on GitHub Pages, proxied onto audiosaw.com by a Cloudflare Pages
Function. It also works directly at
[andrewnakas.github.io/stemflipper](https://andrewnakas.github.io/stemflipper/).

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

| preset | chain | GPU for a 3:30 song |
|---|---|---|
| `fast` | htdemucs | ~30 s |
| `balanced` | RoFormer vocals → htdemucs → drum-kit split | ~57 s |
| `best` | RoFormer vocals → htdemucs_ft → drum-kit split | ~78 s |

Splitting the kit is also what makes drum transcription accurate: a kick and a hat in the
same 10 ms are two onsets in two separate signals. On the test fixture that takes drum
recall from 64/96 to 94/96, with hi-hats going from 35/64 to 64/64 — without any
non-commercially-licensed drum model.

**Transcription picks an engine per stem** and checks the answer: monophonic pitch
tracking for bass and lead vocals (cross-checked against basic-pitch, with an octave
sanity check), the ByteDance model for piano, per-piece onsets for drums, basic-pitch
elsewhere. Every stage records whether it succeeded, fell back or failed, and that trail
ships in `project.json` and is visible on the page under "How this was made".

## The server's daily limit

Running in your browser has no limit. The four-stem version uses the Space, which runs on
**ZeroGPU** — free, but rationed per person per day. All neural work happens in one GPU
call per song, whose length is estimated from the song and preset, and ZeroGPU refuses a
job outright if that estimate exceeds what the caller has left — so the browser does the
same arithmetic before uploading anything. There is a second, separate throttle on the
*number* of runs, which carries no numbers at all and is fixed only by authenticating.

| you are | GPU per day | songs of about 3:30 |
|---|---|---|
| not signed in | 2 min (shared) | 2 |
| free Hugging Face account | 5 min | 5 |
| Hugging Face PRO | 40 min | 42 |

Signing in with Hugging Face spends your own allowance instead of the shared pool. It asks
for `openid profile` only — your name, nothing else.

## Run locally

```bash
uv venv --python 3.10 .venv                          # or: python3.10 -m venv .venv
uv pip install --python .venv/bin/python -r requirements.txt -r requirements-dev.txt
.venv/bin/python -m stemflipper song.mp3 -o out/ --preset best
.venv/bin/python app.py                              # backend at :7860
.venv/bin/python -m pytest -m "not slow"

cd web && npm ci && npm run dev                      # the site
npm test                                             # vitest
npm run mock &                                       # a fake Space that replays real frames
npm run smoke -- --scenario upload --backend http://localhost:7861
npm run smoke -- --scenario local --clip song.wav    # the in-browser pipeline, for real
```

Point the site's **Advanced → Processing server** at `http://127.0.0.1:7860` to use your
own machine and skip the queue and the daily limit entirely.

## Honest limitations

- Transcription is an **editable starting point**, not a finished score. Drums are the
  most accurate part; dense polyphony in `other` is the least.
- In the browser you get two stems, not four. That is a model limit: Demucs' ONNX export
  is 158 MB and onnxruntime-web cannot load it, while MDX-Net is 64 MB and works. Without
  WebGPU the browser path is 10–30x slower than real time, and the page says so before you
  start rather than after.
- Beat tracking sometimes locks to double time on rock — the bundled example reports
  214 BPM for a track that a person would count at 107.
- Samples inherit whatever bleed and reverb the separation left in the stem.
- The Vital patch and the EQ/reverb match approximate the sound; they do not recreate the
  original signal chain.
- Separation weights are trained on MUSDB18 (non-commercial training data), so this is a
  **research/educational demo**, not a commercial service. See `PLAN.md` ("Licensing").
- Unlike the rest of [AudioSaw](https://audiosaw.com/), this tool uploads your audio to a
  GPU server. It is deleted within 6 hours.

## Repo map

`stemflipper/` the server pipeline (`python -m stemflipper`) · `app.py` the Gradio backend ·
`web/` the Vite + TypeScript site · `web/src/local/` the same job done in the browser ·
`tests/` pytest with a deterministic synthetic song ·
`PLAN_V3.md` the current plan · `HANDOFF.md` build state and invariants ·
`dataset/` the synthetic parameter-dataset generator.

The example on the landing page is *Another Queen* by Pure Camomile Jam
([CC0](https://creativecommons.org/publicdomain/zero/1.0/),
[source](https://archive.org/details/gt427PureCamomileJam-PureCamomileJam)), a 30-second
excerpt run through the real pipeline by `web/scripts/make_demo_fixture.mjs`.
