"""Beat and downbeat tracking.

Beat This! (CPJKU, ISMIR 2024, MIT code AND weights) gives real downbeats, which librosa
does not — bar lines, time-signature inference and bar-aligned loop slicing all depend on
them. It is optional: when the package or its checkpoint is unavailable the caller falls
back to librosa's beat tracker and the run is marked "fallback" in project.json.
"""

from __future__ import annotations

import logging

import numpy as np

log = logging.getLogger(__name__)

_MODELS: dict[tuple[str, str], object] = {}
_FAILED = False

#: Beat This! is trained at 22.05 kHz; feeding native-rate audio just wastes time.
BEAT_SR = 22050


def available() -> bool:
    try:
        import beat_this  # noqa: F401

        return True
    except Exception:
        return False


def _get_model(checkpoint: str, device: str):
    key = (checkpoint, device)
    model = _MODELS.get(key)
    if model is None:
        from beat_this.inference import Audio2Beats

        model = Audio2Beats(checkpoint_path=checkpoint, device=device, dbn=False)
        _MODELS[key] = model
    return model


def beat_this_beats(
    y: np.ndarray, sr: int, device: str = "cpu", checkpoint: str = "final0"
) -> tuple[list[float], list[float]] | None:
    """(beats, downbeats) in seconds, or None when unavailable/failed."""
    global _FAILED
    if _FAILED:
        return None
    try:
        import librosa

        mono = y.mean(axis=1) if y.ndim > 1 else y
        if sr != BEAT_SR:
            mono = librosa.resample(np.asarray(mono, dtype=np.float32), orig_sr=sr, target_sr=BEAT_SR)
        model = _get_model(checkpoint, device)
        beats, downbeats = model(np.asarray(mono, dtype=np.float32), BEAT_SR)
        beats = [float(b) for b in np.asarray(beats).ravel()]
        downbeats = [float(b) for b in np.asarray(downbeats).ravel()]
        if len(beats) < 2:
            return None
        return beats, downbeats
    except Exception as e:
        # A missing checkpoint download is the common case on a cold Space; don't retry
        # per stem, just degrade for the rest of the process.
        log.warning("beat_this unavailable (%s) — falling back to librosa", e)
        _FAILED = True
        return None


def librosa_beats(y: np.ndarray, sr: int) -> tuple[list[float], list[float]]:
    """Fallback: librosa beats, with downbeats assumed every 4 beats."""
    from ..analyze import estimate_tempo

    mono = y.mean(axis=1) if y.ndim > 1 else y
    _, beats = estimate_tempo(np.asarray(mono, dtype=np.float32), sr)
    return beats, beats[::4]


def reset() -> None:
    """Clear the model cache and the failure latch (tests)."""
    global _FAILED
    _MODELS.clear()
    _FAILED = False


#: A tracked grid whose beat spacing scatters this much (inter-quartile range as a
#: fraction of the median interval) is not a usable musical grid. Real songs — including
#: live takes that drift — stay far below this; the number catches a tracker that has
#: locked onto the wrong thing (synthetic audio, dense percussion, ambient material).
MAX_INTERVAL_SPREAD = 0.25


def grid_coherence(beats) -> float:
    """Interval spread of a beat list: 0.0 is metronomic, >0.25 is unusable."""
    b = np.asarray(beats, dtype=float)
    if len(b) < 4:
        return 1.0
    d = np.diff(b)
    d = d[d > 1e-3]
    if len(d) < 3:
        return 1.0
    median = float(np.median(d))
    if median <= 0:
        return 1.0
    return float(np.percentile(d, 75) - np.percentile(d, 25)) / median


def beats_are_coherent(beats, downbeats=None) -> tuple[bool, str]:
    """Is this grid trustworthy enough to quantize notes and draw bars against?

    Returns (ok, reason). Two failure modes seen in practice: scattered beat intervals,
    and a downbeat on nearly every beat (the tracker found no bar structure at all).
    """
    b = np.asarray(beats, dtype=float)
    if len(b) < 4:
        return False, "too few beats"
    spread = grid_coherence(b)
    if spread > MAX_INTERVAL_SPREAD:
        return False, f"beat spacing scattered (spread {spread:.2f})"
    if downbeats is not None and len(downbeats) > 0.8 * len(b) and len(b) >= 8:
        return False, f"{len(downbeats)} downbeats in {len(b)} beats (no bar structure)"
    return True, f"spread {spread:.2f}"


def best_grid(y: np.ndarray, sr: int, device: str = "cpu") -> tuple[list[float], list[float], str, str]:
    """(beats, downbeats, source, detail) — neural when coherent, else librosa.

    Beat This! is much better than librosa on real music, but when it fails it fails
    loudly (a scattered grid), and a bad grid is worse than a plain one: it would drag
    every quantized note onto the wrong positions and draw wrong bar lines.
    """
    tracked = beat_this_beats(y, sr, device=device)
    if tracked is not None:
        beats, downbeats = tracked
        ok, reason = beats_are_coherent(beats, downbeats)
        if ok:
            return beats, downbeats, "beat_this", reason
        log.info("beat_this grid rejected (%s) — falling back to librosa", reason)
        fb, fdb = librosa_beats(y, sr)
        return fb, fdb, "librosa", f"beat_this rejected: {reason}"
    fb, fdb = librosa_beats(y, sr)
    return fb, fdb, "librosa", "beat_this unavailable"
