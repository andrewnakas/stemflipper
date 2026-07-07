"""Audio loading/saving helpers. librosa handles mp3/m4a via soundfile/audioread+ffmpeg."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import soundfile as sf


def load_audio(path: str | Path, sr: int | None = None, mono: bool = True):
    """Return (audio, sr). Resamples only if sr is given."""
    import librosa

    y, out_sr = librosa.load(str(path), sr=sr, mono=mono)
    return y, int(out_sr)


def save_audio(path: str | Path, audio: np.ndarray, sr: int) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), audio, sr)
    return path


def duration_of(path: str | Path) -> float:
    try:
        info = sf.info(str(path))
        return info.frames / info.samplerate
    except Exception:  # formats libsndfile can't probe (some mp3/m4a) — decode instead
        import librosa

        return float(librosa.get_duration(path=str(path)))


def is_silent(audio: np.ndarray, threshold: float = 1e-4) -> bool:
    """True when a stem carries no usable signal (e.g. vocals stem of an instrumental)."""
    return float(np.sqrt(np.mean(audio**2))) < threshold
