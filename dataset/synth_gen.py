"""Deterministic torchsynth (audio, params) generator — the synth half of the moat.

torchsynth's ``Voice`` renders a batch of audio *and* the normalized parameter
vector that produced it, entirely on-device and **reproducibly**: for a fixed
``SynthConfig`` the audio for batch index *i* is a pure function of *i*. So we
publish the *generator + the batch indices* ("seeds"), never terabytes of audio
— any consumer regenerates the exact waveforms from the seeds (PLAN.md §6).

Compat note: torchsynth 1.0.2 (latest on PyPI, 2021) imports
``pytorch_lightning.core.lightning.LightningModule`` — a path removed in
pytorch-lightning 2.x. We shim that one module *before* importing torchsynth so
the modern env (PL 2.x / numpy 2.x / torch 2.x) works unchanged. This is the
whole reason the dataset track keeps its own deps out of the app requirements.
"""

from __future__ import annotations

import sys
import types
from dataclasses import dataclass, field
from typing import List

import numpy as np


def _install_lightning_shim() -> None:
    """Make torchsynth's removed deep import path resolve under PL 2.x.

    Idempotent; a no-op if the path already exists (e.g. PL 1.x is installed).
    """
    if "pytorch_lightning.core.lightning" in sys.modules:
        return
    import pytorch_lightning as pl

    try:  # PL 1.x already exposes the deep path — nothing to do.
        import pytorch_lightning.core.lightning  # noqa: F401
        return
    except Exception:
        pass

    shim = types.ModuleType("pytorch_lightning.core.lightning")
    shim.LightningModule = pl.LightningModule
    sys.modules["pytorch_lightning.core.lightning"] = shim


# torchsynth's reproducible mode requires batch_size to be a multiple of this.
REPRODUCIBLE_BATCH_MULTIPLE = 32


@dataclass
class SynthGenConfig:
    """A fully-determining spec for a torchsynth render batch.

    Everything a consumer needs to reproduce audio bit-for-bit lives here plus
    the integer batch index. ``sample_rate``/``buffer_size_seconds`` fix the
    waveform grid; ``batch_size`` fixes torchsynth's internal seed layout (its
    per-item seed is ``batch_idx * batch_size + i``), so changing it changes the
    audio — it is part of the seed, not a free knob.
    """

    sample_rate: int = 44100
    buffer_size_seconds: float = 1.0
    batch_size: int = REPRODUCIBLE_BATCH_MULTIPLE
    batch_indices: List[int] = field(default_factory=lambda: [0])

    def __post_init__(self) -> None:
        if self.batch_size % REPRODUCIBLE_BATCH_MULTIPLE != 0:
            raise ValueError(
                f"batch_size must be a multiple of {REPRODUCIBLE_BATCH_MULTIPLE} "
                f"for reproducible torchsynth output (got {self.batch_size})"
            )
        if any(i < 0 for i in self.batch_indices):
            raise ValueError("batch_indices must be non-negative")

    def to_meta(self) -> dict:
        return {
            "generator": "torchsynth.Voice",
            "sample_rate": self.sample_rate,
            "buffer_size_seconds": self.buffer_size_seconds,
            "batch_size": self.batch_size,
        }


def _build_voice(cfg: SynthGenConfig):
    _install_lightning_shim()
    from torchsynth.config import SynthConfig
    from torchsynth.synth import Voice

    synthconfig = SynthConfig(
        batch_size=cfg.batch_size,
        sample_rate=cfg.sample_rate,
        buffer_size_seconds=cfg.buffer_size_seconds,
        reproducible=True,
    )
    return Voice(synthconfig=synthconfig)


def parameter_names(cfg: SynthGenConfig | None = None) -> List[str]:
    """The ordered names of torchsynth's normalized parameter vector.

    Names are ``"<module>.<parameter>"`` (e.g. ``vco_1.tuning``) — stable across
    runs, so the params column is self-describing in the published dataset.
    """
    cfg = cfg or SynthGenConfig()
    voice = _build_voice(cfg)
    return [f"{mod}.{p}" for (mod, p) in voice.get_parameters().keys()]


def generate_batch(cfg: SynthGenConfig, batch_idx: int):
    """Render one deterministic batch → ``(audio[B,T] float32, params[B,P] float32)``.

    ``audio`` and ``params`` are numpy arrays. Reproducible: same (cfg, batch_idx)
    always yields identical arrays.
    """
    import torch

    voice = _build_voice(cfg)
    with torch.no_grad():
        audio, params, _is_train = voice(batch_idx)
    return (
        audio.detach().cpu().numpy().astype(np.float32),
        params.detach().cpu().numpy().astype(np.float32),
    )


def iter_examples(cfg: SynthGenConfig):
    """Yield one dict per rendered voice, flattening across batches.

    Each example carries the seed (``batch_idx``/``item``) so it is
    independently reproducible, plus the audio and its parameter vector.
    """
    for batch_idx in cfg.batch_indices:
        audio, params = generate_batch(cfg, batch_idx)
        for item in range(audio.shape[0]):
            yield {
                "kind": "synth",
                "batch_idx": int(batch_idx),
                "item": int(item),
                "sample_rate": cfg.sample_rate,
                "audio": audio[item],
                "params": params[item],
            }
