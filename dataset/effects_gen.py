"""Deterministic dasp-pytorch (wet, params) generator — the effects half of the moat.

We take a *clean* input signal and push it through a known differentiable effect
chain (``dasp_pytorch.functional``) whose parameters are **sampled from a seed**.
The emitted example pairs the wet audio with the exact parameter vector that
produced it — the (audio → effect-params) inverse problem is the public gap this
dataset targets (PLAN.md §6). Like the synth half, the audio is a pure function
of the seed, so we publish generator + seeds, not stored audio.

Effects covered on the deterministic default path: 6-band ``parametric_eq``,
``compressor``, ``distortion``. ``noise_shaped_reverberation`` is available via
``EFFECT_SPECS`` but is off the default chain — it is much heavier (12 decay
bands + long FIRs) and internally noise-shaped, which we would have to seed
separately to stay reproducible.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Dict, List, Tuple

import numpy as np


# ---- parameter specifications --------------------------------------------------
# Each effect is a list of (name, low, high) — a physically-sensible sampling
# range for that dasp argument. The flat param VECTOR the dataset stores is the
# concatenation, in this order, of every effect's sampled values on the chain.

EFFECT_SPECS: Dict[str, List[Tuple[str, float, float]]] = {
    "parametric_eq": [
        ("low_shelf_gain_db", -12.0, 12.0),
        ("low_shelf_cutoff_freq", 60.0, 250.0),
        ("low_shelf_q_factor", 0.4, 1.2),
        ("band0_gain_db", -12.0, 12.0),
        ("band0_cutoff_freq", 200.0, 600.0),
        ("band0_q_factor", 0.4, 3.0),
        ("band1_gain_db", -12.0, 12.0),
        ("band1_cutoff_freq", 600.0, 1600.0),
        ("band1_q_factor", 0.4, 3.0),
        ("band2_gain_db", -12.0, 12.0),
        ("band2_cutoff_freq", 1600.0, 4000.0),
        ("band2_q_factor", 0.4, 3.0),
        ("band3_gain_db", -12.0, 12.0),
        ("band3_cutoff_freq", 4000.0, 8000.0),
        ("band3_q_factor", 0.4, 3.0),
        ("high_shelf_gain_db", -12.0, 12.0),
        ("high_shelf_cutoff_freq", 6000.0, 12000.0),
        ("high_shelf_q_factor", 0.4, 1.2),
    ],
    "compressor": [
        ("threshold_db", -40.0, -6.0),
        ("ratio", 1.5, 8.0),
        ("attack_ms", 1.0, 50.0),
        ("release_ms", 20.0, 400.0),
        ("knee_db", 0.0, 12.0),
        ("makeup_gain_db", 0.0, 12.0),
    ],
    "distortion": [
        ("drive_db", 0.0, 24.0),
    ],
    # Heavy / off-default; see module docstring.
    "noise_shaped_reverberation": [
        (f"band{b}_gain", 0.0, 1.0) for b in range(12)
    ] + [
        (f"band{b}_decay", 0.0, 1.0) for b in range(12)
    ] + [("mix", 0.0, 0.6)],
}

DEFAULT_CHAIN: Tuple[str, ...] = ("parametric_eq", "compressor", "distortion")


def _apply_effect(name: str, x, sample_rate: int, values: Dict[str, float]):
    """Call one dasp functional effect. ``x`` is a torch tensor ``(B, C, T)``."""
    import torch
    import dasp_pytorch.functional as F

    def t(v: float):
        # dasp expects per-batch tensors; our batch dim is 1 here.
        return torch.tensor([float(v)], dtype=x.dtype)

    kwargs = {k: t(v) for k, v in values.items()}
    fn = getattr(F, name)
    if name == "noise_shaped_reverberation":
        kwargs["num_samples"] = int(0.5 * sample_rate)
        kwargs["num_bandpass_taps"] = 1023
    return fn(x, sample_rate, **kwargs)


def sample_params(chain: Tuple[str, ...], seed: int) -> Tuple[List[str], List[float], Dict[str, Dict[str, float]]]:
    """Deterministically sample a flat param vector for a chain from ``seed``.

    Returns ``(names, values, by_effect)`` where ``names[i]`` is
    ``"<effect>.<param>"``, ``values`` is the flat vector stored in the dataset,
    and ``by_effect`` is the nested dict used to actually render.
    """
    rng = np.random.default_rng(seed)
    names: List[str] = []
    values: List[float] = []
    by_effect: Dict[str, Dict[str, float]] = {}
    for effect in chain:
        by_effect[effect] = {}
        for pname, lo, hi in EFFECT_SPECS[effect]:
            v = float(rng.uniform(lo, hi))
            by_effect[effect][pname] = v
            names.append(f"{effect}.{pname}")
            values.append(v)
    return names, values, by_effect


def param_names(chain: Tuple[str, ...] = DEFAULT_CHAIN) -> List[str]:
    """Ordered ``<effect>.<param>`` names for a chain (self-describing column)."""
    return [f"{e}.{p}" for e in chain for (p, _lo, _hi) in EFFECT_SPECS[e]]


def render(dry: np.ndarray, sample_rate: int, chain: Tuple[str, ...], seed: int):
    """Apply a seeded effect chain to a mono ``dry`` signal.

    Returns ``(wet[T] float32, param_names, param_values, peak)``. Output is
    peak-normalized to avoid distortion/makeup-gain clipping — ``peak`` is the
    pre-normalization peak so the transform is invertible if a consumer needs it.
    Deterministic: same (dry, chain, seed) → same wet.
    """
    import torch

    x = torch.from_numpy(np.asarray(dry, dtype=np.float32)).reshape(1, 1, -1)
    names, values, by_effect = sample_params(chain, seed)
    with torch.no_grad():
        for effect in chain:
            x = _apply_effect(effect, x, sample_rate, by_effect[effect])
    wet = x.reshape(-1).detach().cpu().numpy().astype(np.float32)
    peak = float(np.max(np.abs(wet))) or 1.0
    wet = (wet / peak).astype(np.float32)
    return wet, names, values, peak


@dataclass
class EffectsGenConfig:
    """Spec for a batch of (wet, params) examples over a set of dry signals."""

    sample_rate: int = 44100
    chain: Tuple[str, ...] = DEFAULT_CHAIN
    seeds: List[int] = field(default_factory=lambda: [0])

    def to_meta(self) -> dict:
        return {
            "generator": "dasp_pytorch.functional",
            "sample_rate": self.sample_rate,
            "chain": list(self.chain),
            "param_names": param_names(self.chain),
        }


def iter_examples(cfg: EffectsGenConfig, dry_signals):
    """Yield one (wet, params) example per (dry signal, seed).

    ``dry_signals`` is an iterable of ``(dry_id, mono float32 array)``. Each
    seed re-parametrizes the whole chain, so N dry × M seeds → N*M examples.
    """
    for dry_id, dry in dry_signals:
        for seed in cfg.seeds:
            wet, names, values, peak = render(dry, cfg.sample_rate, cfg.chain, seed)
            yield {
                "kind": "effects",
                "dry_id": str(dry_id),
                "seed": int(seed),
                "sample_rate": cfg.sample_rate,
                "chain": list(cfg.chain),
                "param_names": names,
                "params": np.asarray(values, dtype=np.float32),
                "dry_peak": peak,
                "audio": wet,
            }
