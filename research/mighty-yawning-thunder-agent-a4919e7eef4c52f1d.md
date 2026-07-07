# StemFlipper — Licensing Research: Music Source Separation Models & Training Data

Research scope: verifiable licensing facts for a COMMERCIAL web product. Three-layer analysis per model:
CODE license vs MODEL WEIGHTS license vs TRAINING DATA license.

## Verified primary-source facts

| Component | Code license | Weights license | Training data | Commercial code? | Commercial weights? |
|---|---|---|---|---|---|
| Demucs (facebookresearch) | MIT (Meta Platforms) | No separate license stated (inherits MIT per repo; unanswered issue #327) | MUSDB18(-HQ) + Meta internal | Yes | Ambiguous — see MUSDB18 |
| MUSDB18 / MUSDB18-HQ | n/a (dataset) | n/a | see below | n/a | NO — educational only |
| Spleeter (deezer) | MIT | MIT (bundled) | musdb + Deezer internal (Bean dataset) | Yes | Yes (per repo), but trained partly on musdb |
| Open-Unmix (sigsep) | MIT | umx/umxhq: permissive; **umxl: CC BY-NC-SA 4.0 NON-COMMERCIAL** | MUSDB18-HQ (umxhq), extra data (umxl) | Yes | umxl = NO |
| BS-RoFormer (lucidrains) | MIT (Phil Wang 2023) | code only — no official weights | n/a (arch only) | Yes | n/a |
| RoFormer checkpoints (viperx/ZFTurbo/UVR) | ZFTurbo repo MIT | No explicit commercial grant | MUSDB18HQ + extra songs | Yes | Ambiguous — trained on MUSDB18HQ |
| audio-separator (nomadkaraoke) | MIT | package MIT; downloaded models = each model's own license | varies | Yes (package) | Depends on model — user's responsibility |

## Key legal takeaway
The recurring trap: permissive MIT CODE does not launder the TRAINING DATA restriction. MUSDB18 is
"provided for educational purposes only and the material... should not be used for any commercial purpose
without the express permission of the copyright holders." Nearly every open MSS model is trained (at least
partly) on MUSDB18/MUSDB18-HQ. Whether a model trained on NC data can be used commercially is legally
unsettled (US: model weights likely not a "derivative work"; EU/CC: NC intent is broad). Commercial vendors
(Moises = "ethical AI", fully licensed content) sidestep this by training on proprietary licensed data.

## Sources (all verified)
- Demucs LICENSE (MIT): https://github.com/facebookresearch/demucs/blob/main/LICENSE
- Demucs weights issue #327: https://github.com/facebookresearch/demucs/issues/327
- MUSDB18 license text: https://github.com/EmilianPostolache/stable-audio-controlnet/blob/master/LICENSE-musdb
- MUSDB18 Zenodo: https://zenodo.org/records/1117372 ; HQ: https://zenodo.org/records/3338373
- SigSep MUSDB18: https://sigsep.github.io/datasets/musdb.html
- Spleeter LICENSE: https://github.com/deezer/spleeter/blob/master/LICENSE
- Open-Unmix (umxl NC): https://sigsep.github.io/open-unmix/ ; weights: https://zenodo.org/records/3370486
- BS-RoFormer LICENSE (MIT): https://github.com/lucidrains/BS-RoFormer/blob/main/LICENSE
- ZFTurbo MSST LICENSE (MIT): https://github.com/ZFTurbo/Music-Source-Separation-Training/blob/main/LICENSE
- audio-separator: https://github.com/nomadkaraoke/python-audio-separator/blob/main/README.md
- Moises ethical AI: search results (chartlex, ai-market-watch)
