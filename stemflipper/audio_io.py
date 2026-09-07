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


# --- v2 helpers ------------------------------------------------------------------
# Separation and sample extraction work on STEREO, native-rate audio (the v1 pipeline
# collapsed everything to mono immediately and lost the stereo image of every stem).

def load_stereo(path: str | Path) -> tuple[np.ndarray, int]:
    """Return (samples[n, channels], sr) at the file's native rate, always 2-D."""
    y, sr = sf.read(str(path), always_2d=True, dtype="float32")
    return y, int(sr)


def to_mono(y: np.ndarray) -> np.ndarray:
    return y.mean(axis=1) if y.ndim > 1 else y


def trim_to_len(y: np.ndarray, n: int) -> np.ndarray:
    """Pad with zeros or truncate so an array is exactly n frames long.

    Separation models pad to their window size, so chained stems come back a few
    hundred samples longer than the mix; summing them without this raises.
    """
    if len(y) == n:
        return y
    if len(y) > n:
        return y[:n]
    pad = [(0, n - len(y))] + [(0, 0)] * (y.ndim - 1)
    return np.pad(y, pad)


def rms_db(y: np.ndarray) -> float:
    """RMS in dBFS; -inf floors at -120."""
    rms = float(np.sqrt(np.mean(np.square(y)))) if y.size else 0.0
    return 20.0 * np.log10(rms) if rms > 1e-6 else -120.0


def peak_db(y: np.ndarray) -> float:
    peak = float(np.max(np.abs(y))) if y.size else 0.0
    return 20.0 * np.log10(peak) if peak > 1e-6 else -120.0


def write_flac(path: str | Path, audio: np.ndarray, sr: int, bits: int = 24) -> Path:
    """Stems ship as FLAC: ~half the size of WAV, and every browser decodes it."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    subtype = {16: "PCM_16", 24: "PCM_24"}.get(bits, "PCM_24")
    sf.write(str(path), audio, sr, format="FLAC", subtype=subtype)
    return path


def write_wav24(path: str | Path, audio: np.ndarray, sr: int) -> Path:
    """Samples/loops ship as 24-bit WAV — the format every sampler and DAW imports."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), audio, sr, subtype="PCM_24")
    return path
