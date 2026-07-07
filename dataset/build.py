"""Assemble the synth + effects generators into a Hugging Face ``datasets`` repo.

Design (PLAN.md §6): the *moat* is a generator + seeds, not stored audio. So the
published artifact is small — the two generator modules, a config of seeds, and a
**demo split** of a few hundred examples with audio embedded so the dataset is
immediately loadable/playable and self-describing. Any consumer regenerates the
full corpus deterministically from the seeds via ``synth_gen`` / ``effects_gen``.

Two configs (``datasets`` "subsets"):
  - ``synth``   : (audio, params) from torchsynth ``Voice``  — the audio→patch task
  - ``effects`` : (wet audio, params) from dasp chains       — the audio→FX task

Audio is stored as a raw ``float32`` waveform column plus ``sample_rate`` (not
the ``datasets.Audio`` feature): ``Audio`` encoding in ``datasets`` 5.x requires
``torchcodec`` (+ system FFmpeg), a heavy codec dep we don't want on the dataset
track. Raw arrays preserve the waveform exactly, keep regeneration deterministic,
and load anywhere with no codec — a consumer reshapes ``audio`` with ``sample_rate``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List

import numpy as np

from . import effects_gen, synth_gen


DEFAULT_SAMPLE_RATE = 44100


# ---- feature schemas -----------------------------------------------------------

def _synth_features(sample_rate: int):
    from datasets import Features, Sequence, Value

    return Features(
        {
            "kind": Value("string"),
            "batch_idx": Value("int32"),
            "item": Value("int32"),
            "sample_rate": Value("int32"),
            "audio": Sequence(Value("float32")),
            "params": Sequence(Value("float32")),
        }
    )


def _effects_features(sample_rate: int):
    from datasets import Features, Sequence, Value

    return Features(
        {
            "kind": Value("string"),
            "dry_id": Value("string"),
            "seed": Value("int32"),
            "sample_rate": Value("int32"),
            "chain": Sequence(Value("string")),
            "param_names": Sequence(Value("string")),
            "params": Sequence(Value("float32")),
            "dry_peak": Value("float32"),
            "audio": Sequence(Value("float32")),
        }
    )


def _to_audio_col(example: dict) -> dict:
    """Normalize the waveform column to a plain float32 list for storage."""
    out = dict(example)
    out["audio"] = np.asarray(example["audio"], dtype=np.float32)
    return out


@dataclass
class BuildConfig:
    """Seeds/spec that fully determine the published demo splits."""

    sample_rate: int = DEFAULT_SAMPLE_RATE
    # synth: which torchsynth batches (each batch = batch_size voices)
    synth_batch_size: int = synth_gen.REPRODUCIBLE_BATCH_MULTIPLE
    synth_batch_indices: List[int] = field(default_factory=lambda: [0])
    # effects: seeds sampled per dry signal; dry signals are the first N synth voices
    effects_seeds: List[int] = field(default_factory=lambda: [0, 1])
    effects_n_dry: int = 4
    effects_chain: tuple = effects_gen.DEFAULT_CHAIN

    def to_card_meta(self) -> dict:
        return {
            "sample_rate": self.sample_rate,
            "synth": {
                "generator": "dataset/synth_gen.py",
                "batch_size": self.synth_batch_size,
                "batch_indices": list(self.synth_batch_indices),
                "param_names_count": 78,
            },
            "effects": {
                "generator": "dataset/effects_gen.py",
                "chain": list(self.effects_chain),
                "seeds": list(self.effects_seeds),
                "n_dry": self.effects_n_dry,
                "param_names": effects_gen.param_names(self.effects_chain),
            },
        }


# ---- generators feeding datasets.Dataset.from_generator ------------------------

def _synth_rows(cfg: BuildConfig):
    scfg = synth_gen.SynthGenConfig(
        sample_rate=cfg.sample_rate,
        batch_size=cfg.synth_batch_size,
        batch_indices=cfg.synth_batch_indices,
    )
    for ex in synth_gen.iter_examples(scfg):
        yield _to_audio_col(ex)


def _dry_signals(cfg: BuildConfig):
    """The first ``effects_n_dry`` synth voices from batch 0 serve as clean inputs."""
    scfg = synth_gen.SynthGenConfig(
        sample_rate=cfg.sample_rate,
        batch_size=cfg.synth_batch_size,
        batch_indices=[0],
    )
    audio, _ = synth_gen.generate_batch(scfg, 0)
    n = min(cfg.effects_n_dry, audio.shape[0])
    return [(f"synth_b0_i{i}", audio[i]) for i in range(n)]


def _effects_rows(cfg: BuildConfig):
    ecfg = effects_gen.EffectsGenConfig(
        sample_rate=cfg.sample_rate,
        chain=cfg.effects_chain,
        seeds=cfg.effects_seeds,
    )
    for ex in effects_gen.iter_examples(ecfg, _dry_signals(cfg)):
        yield _to_audio_col(ex)


def build_synth(cfg: BuildConfig):
    from datasets import Dataset

    return Dataset.from_generator(
        lambda: _synth_rows(cfg), features=_synth_features(cfg.sample_rate)
    )


def build_effects(cfg: BuildConfig):
    from datasets import Dataset

    return Dataset.from_generator(
        lambda: _effects_rows(cfg), features=_effects_features(cfg.sample_rate)
    )


def build_all(cfg: BuildConfig | None = None):
    """Build both configs → ``{"synth": Dataset, "effects": Dataset}``."""
    cfg = cfg or BuildConfig()
    return {"synth": build_synth(cfg), "effects": build_effects(cfg)}


def publish(repo_id: str, cfg: BuildConfig | None = None, private: bool = False, token: str | None = None):
    """Push both configs to an HF ``datasets`` repo. Requires a write token.

    Uploads each split under its config name; a consumer then loads with
    ``load_dataset(repo_id, "synth")`` / ``"effects"``. Also writes the dataset
    card (README) documenting the seeds so the corpus is reproducible from them.
    """
    from huggingface_hub import HfApi

    cfg = cfg or BuildConfig()
    api = HfApi(token=token)
    api.create_repo(repo_id=repo_id, repo_type="dataset", private=private, exist_ok=True)

    built = build_all(cfg)
    for config_name, ds in built.items():
        ds.push_to_hub(repo_id, config_name=config_name, token=token)

    card = _dataset_card(repo_id, cfg)
    api.upload_file(
        path_or_fileobj=card.encode("utf-8"),
        path_in_repo="README.md",
        repo_id=repo_id,
        repo_type="dataset",
        token=token,
    )
    return f"https://huggingface.co/datasets/{repo_id}"


def _dataset_card(repo_id: str, cfg: BuildConfig) -> str:
    import json

    meta = cfg.to_card_meta()
    # The `configs:` block is REQUIRED for load_dataset(repo, "synth"/"effects") to
    # resolve — push_to_hub(config_name=...) writes data under synth/ & effects/ dirs
    # but does not add this mapping when we later overwrite README.md ourselves.
    return f"""---
license: cc-by-4.0
task_categories:
- audio-classification
tags:
- audio
- synthesizer
- audio-effects
- parameter-estimation
- synthetic
pretty_name: StemFlipper synth/effects parameter-estimation scaffold
configs:
- config_name: synth
  data_files:
  - split: train
    path: synth/train-*
- config_name: effects
  data_files:
  - split: train
    path: effects/train-*
---

# StemFlipper — synth & effects parameter-estimation dataset (scaffold)

A synthetic **(audio → parameters)** dataset for the inverse problems StemFlipper
targets: recover a synth patch from its sound, and recover an effect chain from
wet audio. No public dataset pairs real audio with the synth-patch / effect-chain
parameters that produced it — this fills that gap with deterministic synthetic
generation. **The moat is the generator + seeds, not stored audio**: every example
here regenerates bit-for-bit from its seed.

## Configs

- **`synth`** — torchsynth `Voice` renders `(audio, params)`; `params` is the
  78-dim normalized parameter vector (`adsr_1.attack`, `vco_1.tuning`, …).
- **`effects`** — a known `dasp-pytorch` chain (`{', '.join(cfg.effects_chain)}`)
  applied to clean synth voices → `(wet audio, params)`; `param_names` labels each
  value.

```python
from datasets import load_dataset
synth = load_dataset("{repo_id}", "synth", split="train")
fx    = load_dataset("{repo_id}", "effects", split="train")
```

## Reproduce / extend from seeds

The published splits are a small demo. Regenerate or scale up deterministically:

```python
from dataset.synth_gen import SynthGenConfig, iter_examples
list(iter_examples(SynthGenConfig(batch_indices=[0, 1, 2])))  # 3 batches
```

Generation spec (seeds):

```json
{json.dumps(meta, indent=2)}
```

Generated by `dataset/build.py` in the [StemFlipper](https://huggingface.co/spaces/nakas/stemflipper) repo.
"""
