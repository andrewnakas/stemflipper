# Fine-grained / multi-instrument music source separation (2024–2026)

Research summary. Every claim carries a source URL. Note: this is a research deliverable; no code changes required.

---

## 1. Demucs 6-source model — `htdemucs_6s`

- **Stems (6):** vocals, drums, bass, **guitar**, **piano**, other. (`other` = everything not captured by the other five.)
- **Architecture:** Hybrid Transformer Demucs (Demucs v4), released in v4.0.0 on 2022-12-07.
- **Status:** Explicitly "experimental" per the official release notes.
- **Quality caveats:** Guitar is "okay"; piano is known to be poor — "a lot of bleeding and artifacts," "the piano source is not working great." On MUSDB18-HQ, reported SDR ≈ bass 9.11, drums 9.54, vocals 8.66 dB, but `other` ≈ 0.22 dB — a **broken/misleading** number because piano+guitar are carved out of MUSDB's `other`. Recommendation: judge `htdemucs_6s` only on vocals/drums/bass, or sum piano+guitar+other before scoring.
- **Invocation:**
  - pip package: `demucs`
  - `demucs --two-stems=... ` general; for 6 stems: `demucs -n htdemucs_6s track.mp3`
  - ONNX port: HF `StemSplitio/htdemucs-6s-onnx`; CLI `demucs-onnx separate song.mp3 stems/ --model htdemucs_6s`, optionally `--stems guitar piano`.
- **Sources:** https://github.com/facebookresearch/demucs • https://github.com/facebookresearch/demucs/blob/main/docs/release.md • https://pypi.org/project/demucs/ • https://huggingface.co/StemSplitio/htdemucs-6s-onnx

## 2. LarsNet — 5-way drum sub-separation

- **Stems (5):** kick (KD), snare (SD), toms (TT), hi-hat (HH), cymbals (CY).
- **Architecture:** bank of 5 parallel dedicated U-Nets (one per stem, 13 conv layers each), T-F domain; optional α-Wiener filtering post-processing to reduce cross-talk. Faster than real-time.
- **Paper:** "Toward Deep Drum Source Separation," Mezza et al., arXiv:2312.09663, published in Pattern Recognition Letters (2024).
- **Dataset:** StemGMD — 1224 h, nine-piece kit, synthesized from Groove MIDI over 10 acoustic kits, 44.1 kHz. On Zenodo, CC-BY 4.0.
- **nSDR (from paper Table 3):** kick 27.19, snare 21.77, toms 9.10, hi-hat 6.43, cymbals 4.09 dB; overall 17.70 dB. Beats NMFD (10.97) and SAB-NMF (7.24) baselines. **Best: kick/snare; worst: hi-hat/cymbals.**
- **Repo / weights:** GitHub `polimi-ispl/larsnet`. Pretrained checkpoints via Google Drive (562 MB), **CC BY-NC 4.0**. No pip package (clone + `python separate.py -i <dir>`, flags `-w` Wiener, `-o`, `-d`). **Not on HuggingFace.** Also served on MVSEP (algorithm #31) and a VST3 plugin "LARS" (GitHub `EdoardoMor/LARS`).
- **Sources:** https://arxiv.org/abs/2312.09663 • https://arxiv.org/html/2312.09663v1 • https://github.com/polimi-ispl/larsnet • https://polimi-ispl.github.io/larsnet/ • https://mvsep.com/algorithms/31 • https://github.com/EdoardoMor/LARS

## 3. Per-instrument / fine-grained models

### MedleyVox (multi-singer vocal separation)
- **Task:** separate multiple singers — unison, duet, main-vs-rest, N-singing.
- **Model:** Conv-TasNet backbone + iSRNet (ConvNeXt super-resolution), joint-trained.
- **Paper:** ICASSP 2023, arXiv:2211.07302. Dataset (381 segs / 1.1 h, 23 MedleyDB songs) on Zenodo record 7984549.
- **Weights:** official repo `jeonchangbin49/MedleyVox` states **no plan to release pretrained weights**; install via asteroid. A community re-host exists at HF `Cyru5/MedleyVox`.
- **Sources:** https://github.com/jeonchangbin49/MedleyVox • https://arxiv.org/abs/2211.07302 • https://zenodo.org/records/7984549 • https://huggingface.co/Cyru5/MedleyVox

### Guitar separation (community MelBand-RoFormer)
- No pip package literally named "GuitarSep." The de-facto dedicated guitar model is **becruily's Mel-Band RoFormer guitar**: HF `becruily/mel-band-roformer-guitar` (`becruily_guitar.ckpt` + `config_melband_roformer_guitar_becruily.yaml`). Run via ZFTurbo's `Music-Source-Separation-Training` (`--model_type mel_band_roformer`). Also mirrored in `Politrees/UVR_resources`.
- **Sources:** https://huggingface.co/becruily/mel-band-roformer-guitar • https://github.com/ZFTurbo/Music-Source-Separation-Training

### MoisesDB (dataset enabling >4 stems) + models
- MoisesDB: 240 songs (~14.4 h), 47 artists, two-level hierarchical taxonomy, 3–10 stem granularities; arXiv:2307.15913 (ISMIR 2023). HT-Demucs benchmarked at 4- and 6-stem; underperforms oracle on other/piano/guitar.
- **Sources:** https://archives.ismir.net/ismir2023/paper/000073.pdf • https://arxiv.org/abs/2307.15913

### ACMID — 7-stem (2025)
- **Stems (7):** Piano, Drums, Bass, Acoustic Guitar, Electric Guitar, Strings, Wind-Brass.
- Auto-curated dataset (YouTube crawl 4643.51 h → 737.35 h cleaned via instrument classifier). Model: **SCNet**. +2.39 dB SDR (cleaned vs uncleaned); +1.16 dB when added to SCNet 7-stem training. Code+weights: GitHub `scottishfold0621/ACMID`. arXiv:2510.07840.
- **Sources:** https://arxiv.org/abs/2510.07840 • https://arxiv.org/html/2510.07840v1 • https://github.com/scottishfold0621/ACMID

### Piano concerto separation (2024)
- Özer & Müller, "Source Separation of Piano Concertos…", IEEE/ACM TASLP 32:1214–1225 (2024).
- **Source:** https://audiolabs-erlangen.de/resources/MIR/2024-TASLP-PianoConcertoSeparation

## 4. Drum sub-separation & further splitting of "other"

- **DrumSep (aufr33 / jarredou):** MDX23C model. 6-stem variant → kick/snare/toms/hihat/ride/crash; newer v2025 5-stem → kick/snare/toms/hihat/cymbals. Weights: `MDX23C-DrumSep-aufr33-jarredou.ckpt` (~438 MB) on HF `Politrees/UVR_resources`; also `jarredou/models` releases. Runs in UVR5. Reported SDR ~kick 16.66, snare 11.53, toms 12.33. Original DrumSep tooling: GitHub `inagoy/drumsep`.
- **HTDemucs FT single-stem models:** drums FT SDR 11.13, bass FT SDR 11.96 (ZFTurbo doc).
- **BS-Rofo-SW (jarredou):** 6-stem BS-RoFormer → vocals/drums/bass/guitar/piano/other; common default in the community stack. GitHub `openmirlab/bs-roformer-infer`.
- **ReStem:** consumer app, drums → kick/snare/hi-hat/toms/ride/crash.
- **Splitting "other":** achieved by adding guitar (becruily), piano, strings/winds (ACMID/SCNet), and de-reverb/denoise MelBand-RoFormer utility models — ensembled in the ZFTurbo/MSST + UVR5/MVSEP stack.
- **Sources:** https://mvsep.com/algorithms/29 • https://huggingface.co/Politrees/UVR_resources • https://github.com/jarredou/models/releases • https://github.com/inagoy/drumsep • https://github.com/ZFTurbo/Music-Source-Separation-Training/blob/main/docs/pretrained_models.md • https://rebeatapp.com/
