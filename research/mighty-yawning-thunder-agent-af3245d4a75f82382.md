# Audio Source Separation Libraries — Technical Research Report (July 2026)

Research feeding an implementation plan. Every claim is sourced. Data verified against
PyPI, GitHub, HuggingFace, and PyTorch docs as of 2026-07-06.

## TL;DR / Recommendation

- **Use `audio-separator` (nomadkaraoke/python-audio-separator)** as the primary engine. It
  is the only actively maintained, modern package that wraps the full UVR model ecosystem
  (MDX, MDXC/MDX23C, VR Arch, Demucs v4, **BS-RoFormer, Mel-Band RoFormer**), pulls weights
  automatically from HuggingFace, and offers a clean Python API + CLI with GPU/CPU install
  extras. Actively released (v0.44.2, May 2026).
- **`demucs`** is high quality but **frozen** — GitHub repo archived Jan 1 2025, last PyPI
  release 4.0.1 (Sep 2023). Fine as a dependency (audio-separator uses its models), not as a
  living project.
- **`torchaudio` HDEMUCS** gives a zero-extra-dependency Hybrid Demucs path if you are
  already on PyTorch, but torchaudio itself is being wound down (feature-frozen, maintenance
  mode as of the 2.8/2.9 era).
- **`spleeter`** is legacy (TensorFlow, old architecture). Still gets occasional releases
  (2.4.2, Apr 2025) but is not competitive in quality. Avoid for new work.
- **UVR / UVR5** is the GUI app and, more importantly, the **model ecosystem** that
  audio-separator draws from. Not a pip library.

---

## 1. `demucs` (Facebook/Meta Research)

| Field | Value |
|---|---|
| pip install | `pip install -U demucs` |
| Latest PyPI version | **4.0.1** — released **Sep 7, 2023** |
| Python requirement | Python >= 3.8.0 |
| PyTorch dependency | PyTorch >= 1.12 (per v3.0.5+ notes); works on modern torch/torchaudio |
| GitHub | facebookresearch/demucs — **ARCHIVED (read-only) since ~Jan 1, 2025** |
| Community fork | github.com/adefossez/demucs — "only important bug fixes will be processed" |
| Maintenance status | **NOT actively maintained.** README verbatim: *"As I am no longer working at Meta, this repository is not maintained anymore."* |
| Architecture | v4 = Hybrid Transformer Demucs (htdemucs) |

**Available pretrained models:** `htdemucs` (default), `htdemucs_ft` (fine-tuned, 4-bag
ensemble, slower/better), `htdemucs_6s` (6 stems: adds guitar + piano), `hdemucs_mmi` (v3
retrained), and MDX-era: `mdx`, `mdx_extra`, `mdx_q`, `mdx_extra_q`.

**Model download mechanism:** Weights auto-download on first use via **PyTorch Hub cache**.
Original weights hosted at `https://dl.fbaipublicfiles.com/demucs/` (e.g. the htdemucs bag
`.../hybrid_transformer/955717e8-8726e21a.th`). **No official Meta HuggingFace weight repo**
— but community mirrors exist (`CrazeDigger/htdemucs` TorchScript, `StemSplitio/htdemucs-ft-pytorch`,
`hugggof/demucs_extra`, and `demucs.cpp` ggml weights).

**Quality note:** htdemucs = 9.00 dB SDR on MUSDB HQ test; htdemucs_ft ≈ 9.20 dB. Segment
max length 7.8s. Trained on MUSDB HQ + 800 extra songs.

Sources:
- https://github.com/facebookresearch/demucs
- https://raw.githubusercontent.com/facebookresearch/demucs/main/README.md
- https://pypi.org/project/demucs/
- https://github.com/adefossez/demucs
- https://huggingface.co/CrazeDigger/htdemucs
- https://huggingface.co/StemSplitio/htdemucs-ft-pytorch

---

## 2. `audio-separator` (nomadkaraoke / beveradb) — THE KEY MODERN PACKAGE

| Field | Value |
|---|---|
| pip install name | `audio-separator` |
| Latest PyPI version | **0.44.2** — released **May 18, 2026** (actively released) |
| Python requirement | Python >= 3.10 |
| GitHub | github.com/nomadkaraoke/python-audio-separator (formerly `karaokenerds/` and `beveradb/`) |
| Maintainer | @beveradb (Andrew Beveridge) |
| Maintenance status | **Actively maintained** (frequent releases through 2026) |
| Conda | `beveradb/audio-separator` channel |

**Install extras (pick one):**
```bash
pip install "audio-separator[gpu]"   # Nvidia CUDA (11.8 / 12.2). Pulls onnxruntime-gpu + CUDA torch
pip install "audio-separator[cpu]"   # CPU-only, and Apple Silicon (M1+, CoreML)
pip install "audio-separator[dml]"   # DirectML (Windows GPU acceleration)
# Conda GPU:
conda install pytorch=*=*cuda* onnxruntime=*=*cuda* audio-separator -c pytorch -c conda-forge
```
Supported CUDA versions: **11.8 and 12.2**.

**Key dependencies:** `torch`, `onnx`, `onnxruntime` (or `onnxruntime-gpu`), `numpy`,
`librosa`, `requests`, `six`, `tqdm`, `pydub`. Runs both **PTH (PyTorch)** and **ONNX** model
formats.

**Supported model architectures (the full modern set):**
- **MDX** (MDX-Net, ONNX)
- **MDXC / MDX23C** (checkpoint-based; this family includes **BS-RoFormer** and **Mel-Band
  RoFormer** models)
- **VR Arch** (Vocal Remover architecture, the classic UVR models)
- **Demucs** (v4, incl. htdemucs variants, up to 6 stems)

So RoFormer support (BS-RoFormer / Mel-Band RoFormer, current SOTA) comes in via the
MDXC/config-driven loader — **yes, both are supported.**

**Model hosting / download from HuggingFace:** Models are **automatically downloaded on first
use** to `--model_file_dir` (default `/tmp/audio-separator-models/`). The package ships a
curated model list (viewable via `--list_models`, showing stems, SDR scores, and friendly
names) and fetches weights + configs from **HuggingFace-hosted model repositories** maintained
for the project (the audio-separator / UVR model collection). The **default model is
`UVR-MDX-NET-Inst_HQ_3`**. Any listed file can be forced with `--model_filename` (e.g.
`model_bs_roformer_ep_317_sdr_12.9755.ckpt`, `UVR_MDXNET_KARA_2.onnx`,
`MDX23C-8KFFT-InstVoc_HQ.ckpt`).
> Note: the exact HF repo IDs are defined in the package's model-list/config manifest
> (`download_checks.json`-style); confirm the live repo ID at implementation time from
> `audio_separator/separator/` source since these have been migrated (see repo issue #184).
> The user-facing HF Space is `huggingface.co/spaces/nomadkaraoke/audio-separator`.

**CLI usage:**
```bash
audio-separator --list_models
audio-separator /path/to/input.wav --model_filename model_bs_roformer_ep_317_sdr_12.9755.ckpt
```

**Python API:**
```python
from audio_separator.separator import Separator

separator = Separator()
separator.load_model()                       # loads default (or pass model_filename=...)
output_files = separator.separate('audio1.wav')
print(f"Output file(s): {' '.join(output_files)}")
```

Sources:
- https://github.com/nomadkaraoke/python-audio-separator
- https://github.com/nomadkaraoke/python-audio-separator/blob/main/README.md
- https://pypi.org/project/audio-separator/
- https://github.com/nomadkaraoke/python-audio-separator/issues/184 (model repo link migration)
- https://github.com/nomadkaraoke/python-audio-separator/discussions/133 (model choice guidance)
- https://huggingface.co/spaces/nomadkaraoke/audio-separator

---

## 3. `spleeter` (Deezer)

| Field | Value |
|---|---|
| pip install name | `spleeter` |
| Latest PyPI version | **2.4.2** — released **Apr 3, 2025** |
| Python requirement | Python >= 3.8, **< 3.12** |
| Framework | **TensorFlow** (older architecture) |
| GitHub | github.com/deezer/spleeter |
| Maintenance status | **Legacy / low activity.** Still gets occasional releases but architecturally dated; not competitive with RoFormer/Demucs on quality. Python-version ceiling (<3.12) reflects TF constraints. |

**Stem models:** 2-stem (vocals/accompaniment), 4-stem (vocals/drums/bass/other), 5-stem
(adds piano). ~100x realtime on GPU. Models auto-download from Deezer-hosted GitHub release
archives on first use.

**Verdict:** Only choose if you specifically need Spleeter's speed/footprint or existing TF
pipeline compatibility. Not recommended for new quality-sensitive work.

Sources:
- https://github.com/deezer/spleeter
- https://pypi.org/project/spleeter/
- https://research.deezer.com/projects/spleeter

---

## 4. `torchaudio` — built-in Hybrid Demucs

**Yes, torchaudio ships HDemucs.** Two pretrained pipelines in `torchaudio.pipelines`:

- **`HDEMUCS_HIGH_MUSDB`** — Hybrid Demucs trained on MUSDB-HQ (train set).
- **`HDEMUCS_HIGH_MUSDB_PLUS`** — trained on MUSDB-HQ train+test **plus 150 extra Meta internal
  songs**. Higher quality; suited for ~44.1 kHz audio.

Both separate into **drums, bass, other, vocals** (4 stems). Model class is
`torchaudio.models.HDemucs` (built via `hdemucs_high()`). Weights auto-download via the
torchaudio pipeline bundle (Torch Hub cache). Because HDemucs is memory-heavy, the standard
pattern is to chunk the song, run segment-by-segment, and stitch back.

| Field | Value |
|---|---|
| Install | comes with `torchaudio` (`pip install torchaudio`) |
| Pipelines | `HDEMUCS_HIGH_MUSDB`, `HDEMUCS_HIGH_MUSDB_PLUS` |
| Docs version confirmed | torchaudio 2.8 / 2.9 / 2.10 all document it |
| Maintenance caveat | **torchaudio is in maintenance/feature-freeze mode** (PyTorch has been winding down active torchaudio development). Pipelines still ship and work, but don't expect new SOTA models here. |

**Trade-off vs audio-separator:** torchaudio HDEMUCS = zero extra deps if already on PyTorch,
but only 4-stem Hybrid Demucs — **no RoFormer, no MDX, no model choice.** audio-separator gives
the whole model zoo at the cost of extra deps (onnxruntime).

Sources:
- https://docs.pytorch.org/audio/2.8/tutorials/hybrid_demucs_tutorial.html
- https://docs.pytorch.org/audio/stable/generated/torchaudio.pipelines.HDEMUCS_HIGH_MUSDB.html
- https://docs.pytorch.org/audio/stable/generated/torchaudio.pipelines.HDEMUCS_HIGH_MUSDB_PLUS.html
- https://docs.pytorch.org/audio/stable/generated/torchaudio.models.HDemucs.html

---

## 5. Ultimate Vocal Remover (UVR / UVR5) — the model ecosystem

**Not a pip package** — it's a desktop **GUI app** (Anjok07/ultimatevocalremovergui) and,
critically, the **model ecosystem** that audio-separator wraps. UVR5 = current major line
(v5.6+).

**Supported model architectures in UVR5** (mirrors what audio-separator loads): VR Arch,
MDX-Net, **MDX23C**, Demucs v4, **Mel-Band RoFormer**, **BS-RoFormer**. RoFormer models are the
current SOTA for vocal/instrumental separation (e.g. `model_bs_roformer_ep_317_sdr_12.9755`).

**HuggingFace ecosystem** (where UVR-family weights live / are mirrored — useful repo IDs):
- `Politrees/UVR_resources` — models + YAML configs (incl. Demucs v4 configs)
- `Derur/UVR-models` — models + `download_checks.json` manifest
- `anvuew/dereverb_bs_roformer` — RoFormer dereverb models
- `Eddycrack864/UVR5-UI` — Gradio UI built on python-audio-separator
- HF Spaces: `r3gm/Audio_separator`, `Ryouko65777/python-audio-separator`

**Relationship for implementation:** UVR5 (GUI) and audio-separator (library/CLI) consume the
**same model files and configs**. audio-separator = "UVR without the GUI," designed exactly for
programmatic use. UVR5-UI on HF is explicitly "based on python-audio-separator."

Sources:
- https://github.com/Anjok07/ultimatevocalremovergui
- https://ultimatevocalremover.com/
- https://sourceforge.net/projects/ult-vocal-remover-uvr.mirror/
- https://github.com/Eddycrack864/UVR5-UI
- https://huggingface.co/Politrees/UVR_resources
- https://huggingface.co/Derur/UVR-models
- https://huggingface.co/anvuew/dereverb_bs_roformer

---

## Comparison Matrix

| Package | pip name | Latest ver (date) | Maintained 2025-26? | Framework | Models | HF hosting |
|---|---|---|---|---|---|---|
| **audio-separator** | `audio-separator[gpu/cpu/dml]` | 0.44.2 (May 2026) | **Yes, active** | PyTorch + ONNX | MDX, MDXC/MDX23C, VR Arch, Demucs v4, **BS/Mel-Band RoFormer** | Yes (auto-download; UVR model repos) |
| **demucs** | `demucs` | 4.0.1 (Sep 2023) | **No — archived Jan 2025** | PyTorch | htdemucs (+ft/6s), hdemucs_mmi, mdx* | fbaipublicfiles (Torch Hub); community HF mirrors |
| **torchaudio HDEMUCS** | `torchaudio` | tracks torch | Maintenance-mode | PyTorch | HDEMUCS_HIGH_MUSDB(_PLUS), 4-stem | Torch Hub bundle |
| **spleeter** | `spleeter` | 2.4.2 (Apr 2025) | Legacy/low | TensorFlow | 2/4/5-stem | GitHub release archives |
| **UVR5** (app, not pip) | — | v5.6+ | Yes (GUI) | PyTorch/ONNX | VR/MDX/MDX23C/Demucs/RoFormer | Yes (Politrees, Derur, etc.) |

## Implementation guidance

1. **Primary path:** `audio-separator[gpu]` (CUDA) or `audio-separator[cpu]` (CPU / Apple
   Silicon). Default model `UVR-MDX-NET-Inst_HQ_3`; for best quality use a **BS-RoFormer**
   checkpoint via `--model_filename`. Pin the version (0.44.x) in requirements.
2. **Lightweight/no-onnxruntime path:** if already committed to PyTorch and only need 4-stem
   Demucs, use `torchaudio.pipelines.HDEMUCS_HIGH_MUSDB_PLUS` — no extra deps.
3. **Model caching:** set `--model_file_dir` to a persistent path (default `/tmp/...` is
   ephemeral) so HF downloads survive restarts; pre-warm in Docker build.
4. **Avoid** spleeter and standalone demucs-the-repo for anything new; treat demucs models as a
   dependency consumed through audio-separator instead.
5. **Verify at build time:** exact HF repo IDs for the audio-separator model manifest have been
   migrated over time — read them from the installed `audio_separator` package source rather
   than hardcoding, and run `audio-separator --list_models` to snapshot the current catalog.
