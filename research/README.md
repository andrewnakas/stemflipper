# Research reports (from the six parallel SOTA research agents, 2026-07-06)

These are the fully-cited evidence behind `PLAN.md`. **The appendix mapping inside PLAN.md
contains two errors — use this table instead:**

| File | Actual content |
|---|---|
| `...agent-a5b76e6d6c6395dd7.md` | Source separation SOTA (SDR leaderboard, VRAM/timing, licensing) |
| `...agent-af3245d4a75f82382.md` | Source separation **libraries** (audio-separator vs demucs vs torchaudio) |
| `...agent-a1ee2af2504e9be03.md` | Fine-grained separation (htdemucs_6s, LarsNet, DrumSep, guitar models) |
| `...agent-a567b1347fdd2ef91.md` | Audio→MIDI transcription (basic-pitch, ByteDance piano, f0 trackers, quantization) |
| `...agent-a698f884d324ef7fc.md` | **Drum transcription (ADT)** — PLAN.md wrongly labels this "synth/effects reconstruction" |
| `...agent-a7ddadb6df240c3a9.md` | DAW export formats (SMF, RPP, DAWproject, SFZ/DecentSampler, .als) |
| `...agent-a634de2bf318aaea0.md` | HF Spaces deployment (ZeroGPU, Gradio, pricing, caching) |
| `...agent-ab65c47206add3abe.md` | Datasets & training (Slakh2100, torchsynth/synth1B1, copyright) |
| `...agent-a4919e7eef4c52f1d.md` | Licensing deep-dive (code vs weights vs training data) |

**Missing report:** the detailed synth/timbre/effects-reconstruction report was delivered
in-chat and never saved to disk. The only surviving distillation is **PLAN.md §4
"Reconstruction — sampler + synth-fit + effects"** — treat that section as the ground truth for
M5 (INSTRUMENTAL arXiv:2603.15905, Syntheon, CMA-ES, dasp-pytorch auto_eq, FiNS blind-IR,
ST-ITO, pedalboard GPLv3 caveat). Do not go hunting for a fuller report; it doesn't exist.
