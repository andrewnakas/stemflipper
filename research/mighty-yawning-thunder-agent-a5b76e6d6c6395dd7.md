# StemFlipper — Music Source Separation: State of the Art (2024–2026)

Technical research report feeding the StemFlipper implementation plan. Every SDR figure is on **MUSDB18-HQ** (BSSEval/museval, dB, higher = better) unless noted. Cross-source SDR numbers are directional, not exact — papers use different train sets and community leaderboards (MVSEP/ZFTurbo) use a *different* test set (MultiSong).

---

## 1. SOTA Separation Models — SDR Leaderboard & Comparison

### MUSDB18-HQ average SDR leaderboard (4-stem avg)

| Model | Avg SDR (dB) | Stems | Family | Params | License (code) | Source |
|---|---|---|---|---|---|---|
| **BS-RoFormer** (L=12, +500 songs) | **11.99** | 4 | Freq-domain Transformer | 93.4M | MIT (lucidrains) | arXiv:2309.02612 |
| **BS-RoFormer** (L=6, no extra) | 9.80 / 9.92 | 4 | Transformer | 72.2M | MIT | 2309.02612 / 2310.01809 |
| **Mel-Band RoFormer** (L=6) | ~9.64* (per-stem SOTA) | 4 | Transformer | 84.2M | MIT | arXiv:2310.01809 |
| SCNet-large | 9.69 | 4 | CNN | — | MIT | 2024 |
| Sparse HT Demucs (f.t.) | 9.20 | 4 | Hybrid+Transformer | ~41M | MIT | arXiv:2211.08553 |
| **HT Demucs f.t.** (≈`htdemucs_ft`) | 9.00 | 4 | Hybrid+Transformer | 26.9–41.4M | MIT | 2211.08553 |
| Band-Split RNN | 8.24–8.97 | 4 | RNN | — | — | 2209.15174 |
| TFC-TDF-UNet v3 | 8.34 | 4 | Spectrogram U-Net | — | MIT | 2306.09382 |
| **Hybrid Demucs v3** (≈`hdemucs_mmi`) | 7.64–8.34 | 4 | Hybrid | — | MIT | 2111.03600 |
| KUIELab-MDX-Net | ~7.5 | 4 | Two-stream spectrogram+waveform | — | MIT | 2111.12203 |
| Open-Unmix **UMXL** | ~6.3 | 4 | BiLSTM spectrogram | ~8.9M/target | MIT code / **CC BY-NC-SA weights** | JOSS 2019 |
| Spleeter (MWF) | ~5.91 | 2/4/5 | Spectrogram U-Net (TF) | — | MIT | JOSS 2020 |
| Open-Unmix **UMX** | ~5.33 | 4 | BiLSTM | ~8.9M/target | MIT | JOSS 2019 |

\* Mel-RoFormer's paper has **no clean overall-average** (Table 1 typo/dashes); its SOTA claim is per-stem (vocals ~11.6). The **11.99 dB SDX23 win belongs to BS-RoFormer, not Mel-RoFormer** — commonly conflated.

**Papers With Code leaderboard** (`paperswithcode.com/sota/music-source-separation-on-musdb18-hq`) has been **sunset** — the URL now redirects to Hugging Face. Numbers above reconstructed from primary papers.

### Per-model notes
- **BS-RoFormer** (ByteDance, arXiv:2309.02612, ICASSP 2024): complex spectrogram → 62-subband band-split → hierarchical time + subband Transformers with RoPE. SDX23 Leaderboard C 1st place. `lucidrains/BS-RoFormer` code is MIT but ships **no weights**.
- **Mel-Band RoFormer** (arXiv:2310.01809): same backbone, learnable overlapping mel-scale band-split front end. Best per-stem vocals (~11.6). Popular community checkpoints are 2-stem vocal/instrumental.
- **Demucs v4 / htdemucs** (Meta, arXiv:2211.08553): hybrid dual-branch (waveform + spectrogram) U-Net with cross-domain Transformer bottleneck. `htdemucs_ft` = **bag of 4 fine-tuned models** → 4× disk, 4× slower, +~0.2 dB.
- **MDX-Net / MVSEP-MDX23** (arXiv:2111.12203): two-stream spectrogram + Demucs waveform branch. MDX23 = ensemble of Demucs + MDX + RoFormer models.
- **Open-Unmix** (JOSS 2019): 3-layer BiLSTM + FC, one model per target. Reference baseline, not SOTA.
- **Spleeter** (Deezer, JOSS 2020): 12-layer U-Net, TensorFlow. Fast but dated; benefits from proprietary training data. Checkpoints ~76 MB (2-stem) / ~151 MB (4-stem) / ~189 MB (5-stem).

---

## 2. Fine-Grained Separation (beyond 4 stems)

- **`htdemucs_6s`** (Demucs 6-source, "experimental"): vocals, drums, bass, **guitar**, **piano**, other. Guitar "okay," **piano is weak** (bleeding/artifacts). Run `demucs -n htdemucs_6s track.mp3`. ONNX at HF `StemSplitio/htdemucs-6s-onnx`. Its published `other` SDR (~0.2 dB) is a MUSDB scoring artifact, not a quality signal.
- **LarsNet** (arXiv:2312.09663, Pattern Recognition Letters 2024): drum → **kick/snare/toms/hi-hat/cymbals** via 5 parallel U-Nets. nSDR: kick 27.19, snare 21.77, toms 9.10, hi-hat 6.43, cymbals 4.09 (overall 17.70). GitHub `polimi-ispl/larsnet`; weights on Google Drive (562 MB, **CC BY-NC 4.0**, no pip, not on HF). Trained on StemGMD.
- **DrumSep** (aufr33/jarredou, MDX23C): drum → kick/snare/toms/hihat/ride/crash. `MDX23C-DrumSep-aufr33-jarredou.ckpt` (~438 MB) at HF `Politrees/UVR_resources`, runs in UVR5/audio-separator. SDR ~kick 16.66, snare 11.53, toms 12.33.
- **becruily Mel-Band RoFormer guitar**: dedicated guitar model, HF `becruily/mel-band-roformer-guitar`, run via ZFTurbo MSST. (No pip package named "GuitarSep.")
- **MedleyVox** (arXiv:2211.07302, ICASSP 2023): multi-singer separation. Official repo withholds weights; community re-host HF `Cyru5/MedleyVox`.
- **ACMID 7-stem** (arXiv:2510.07840, 2025): piano/drums/bass/acoustic guitar/electric guitar/strings/wind-brass via SCNet. Code+weights `scottishfold0621/ACMID`.
- **MoisesDB** (arXiv:2307.15913): 240-song dataset with 3–10 stem hierarchical taxonomy enabling >4 stems.

**Reality:** splitting "other" into guitar/piano/strings is done by **ensembling instrument-specific models** (becruily guitar + ACMID/SCNet + de-reverb utilities) in the ZFTurbo MSST / UVR5 stack. No single high-quality all-instrument model exists yet.

---

## 3. Python Libraries & Packages

| Package | pip | Latest | Maintained 2025-26? | Notes |
|---|---|---|---|---|
| **`audio-separator`** | `audio-separator[gpu]` / `[cpu]` / `[dml]` | 0.44.2 (May 2026) | **YES, actively** | **Recommended engine.** Wraps MDX, MDXC/MDX23C (incl. **BS-RoFormer + Mel-Band RoFormer**), VR Arch, Demucs v4. Auto-downloads weights from HF UVR collection. `Separator().load_model(); separate('x.wav')`. |
| **`demucs`** | `pip install -U demucs` | 4.0.1 (Sep 2023) | **FROZEN** | `facebookresearch/demucs` **archived ~Jan 2025** ("no longer working at Meta... not maintained"). Fork `adefossez/demucs` = important bug fixes only. Models auto-download via PyTorch Hub from `dl.fbaipublicfiles.com`. |
| **`torchaudio`** | (part of PyTorch) | — | Maintenance-mode | Built-in `torchaudio.pipelines.HDEMUCS_HIGH_MUSDB(_PLUS)` — 4-stem, no onnxruntime dependency. No RoFormer/MDX. |
| **`spleeter`** | `spleeter` | 2.4.2 (Apr 2025) | Legacy/low | TensorFlow, architecturally dated, not competitive. |
| **UVR5** | — (GUI app) | v5.6+ | Ecosystem | `Anjok07/ultimatevocalremovergui`. audio-separator = "UVR without the GUI." |

**Recommendation:** build on **audio-separator** (BS-RoFormer for quality); optional **torchaudio HDEMUCS** fallback for a no-onnxruntime 4-stem path; treat `demucs` as a consumed dependency, not a live project; skip Spleeter.

---

## 4. Practical Deployment

### Memory (VRAM inference, one 3–4 min song)
- **htdemucs**: ~7 GB default, ~3 GB floor (`--segment 8`). System RAM CPU-mode ~7 GB (recommend 16 GB).
- **htdemucs_ft**: ~6 GB (runs 4 models).
- **MDX-Net**: ~2–4 GB (lightest).
- **BS-/Mel-Band RoFormer**: ~6–8 GB inference, tunable via `chunk_size`. (The "40 GB" figure is **training**, not inference.)
- **MVSEP-MDX23** (`--large_gpu`): >11 GB.

### Processing time (3–4 min song)
| Model | CPU | GPU |
|---|---|---|
| htdemucs | ~4–8 min | ~24 s (RTX 3090); ~30–45 s (A40 e2e) |
| htdemucs_ft | ~15–25 min (i5/i7) | ~90–150 s |
| BS-RoFormer | slow (~2 min M3 Max) | ~60–120 s (A40) |
| MDX-Net | ~5–15 min | ~30–36 s |

CPU is ~5–20× slower than GPU. Only Spleeter runs acceptably on CPU; others need GPU for reasonable latency.

### HuggingFace Spaces
- **Free CPU Basic**: 2 vCPU / 16 GB RAM / $0. Demucs runs but ~4–6 min/song. Gotchas: **~60 s HTTP gateway timeout** (must use Gradio SSE queue for multi-min jobs); **sleeps after 48 h idle**.
- **Paid GPU**: T4 small $0.40/hr, A10G small $1.00/hr, L40S $1.80/hr, A100 large $2.50/hr (per-minute billing). H100 removed from Spaces Dec 2025.
- **ZeroGPU** (hardware: A100 → H200 70GB → **RTX Pro 6000 Blackwell 48/96GB since ~May 2026**): **free to *use*** for anyone; **hosting requires PRO ($9/mo)** (up to 10 spaces). Daily quota: anon 2 min, free signed-in 5 min, PRO 40 min, Enterprise 60 min. Over-quota $1/10 min. **Per-call default 60 s** (raise via `@spaces.GPU(duration=120)`). htdemucs (~30–45 s) fits; htdemucs_ft (~90–150 s) needs raised duration.
- Reference space: `abidlabs/music-separation` (htdemucs via `@spaces.GPU` on ZeroGPU).

**Deployment take:** ZeroGPU (PRO $9/mo to host) is cheapest viable for htdemucs; free CPU works for a demo only; dedicated T4/A10G for production throughput.

---

## 5. Licensing for a Commercial Product

**Bottom line: code is MIT (safe); the risk is that usable weights are trained on MUSDB18, which is "educational purposes only... not for any commercial purpose without express permission."** MIT code does not launder the training-data restriction.

| Layer | Commercial-safe? | Notes |
|---|---|---|
| **All code** (Demucs, Spleeter, Open-Unmix, RoFormer, audio-separator) | **Yes — all MIT** | Retain license notices. |
| **Spleeter weights** | **Lowest-risk open option** | MIT weights from Deezer (who also sells Spleeter Pro); still partly musdb-trained. |
| **Open-Unmix umxhq/umx** | Likely OK | But **umxl is explicitly CC BY-NC-SA 4.0 — do NOT use commercially.** |
| **Demucs / RoFormer / UVR weights** | **Legal risk** | Trained on MUSDB18(-HQ); no affirmative commercial grant; NC-data→weights question unsettled. |
| **LarsNet weights** | **No** | CC BY-NC 4.0 (non-commercial). |
| **Any MUSDB18-trained weights** | **Not clean** | Cleanest path = retrain on licensed data or get rights-holder permission. |

Key facts:
- **MUSDB18** license (verbatim): *"provided for educational purposes only... should not be used for any commercial purpose without the express permission of the copyright holders."* Composed of MedleyDB (CC BY-NC-SA 4.0) + DSD100 + Native Instruments + Easton Ellises (CC BY-NC-SA 3.0). The NC/SA clauses are the constraint.
- **Demucs**: MIT code; issue #327 asking about weights license was **never answered** — no affirmative commercial grant for weights specifically.
- **audio-separator**: MIT package, but its license **does not extend to the models it downloads** — each carries its own license; verification burden is on you.
- **What commercial vendors do**: **Moises.ai** trains exclusively on licensed content (MoisesDB); **LALAL.AI** uses proprietary engines. Serious paid products **do not ship raw MUSDB18-trained open weights** — they reuse the MIT *code* and retrain on licensed data.

**This is a factual/legal-landscape summary, not legal advice.** The NC-data→weights question is genuinely unsettled — get a lawyer's review before launch.

---

## Recommendation for StemFlipper

1. **Engine**: `audio-separator` (active, RoFormer + Demucs + MDX under one API, HF auto-download). BS-RoFormer for top quality; htdemucs for speed/6-stem guitar+piano.
2. **Fine-grained**: htdemucs_6s for guitar/piano (piano weak); LarsNet/DrumSep for drum sub-separation (NC-licensed — dev/demo only); becruily guitar + ACMID for "other" splitting via ZFTurbo MSST.
3. **Deploy**: ZeroGPU (PRO $9/mo) or T4/A10G Space for prototype; use SSE queue to dodge the 60 s timeout.
4. **Commercial licensing**: the MIT code is fine; **the MUSDB18-trained weights are the real blocker for a paid product.** Plan to either retrain on licensed data (the Moises approach) or accept/legally-review the risk. Avoid umxl and LarsNet weights in production.
