"""Audio loading/saving helpers. librosa handles mp3/m4a via soundfile/audioread+ffmpeg."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import soundfile as sf


def load_audio(path: str | Path, sr: int | None = None, mono: bool = True):
    """Return (audio, sr). Resamples only if sr is given.

    Goes through load_stereo so every read in the pipeline shares one hardened decode
    path: calling librosa directly here would reintroduce the silent short-decode that
    turns an AAC-as-MP3 upload into 15 ms of noise.
    """
    y, native_sr = load_stereo(path)
    y = to_mono(y) if mono else y.T  # librosa's callers expect (channels, samples)
    if sr is not None and int(sr) != native_sr:
        import librosa

        y = librosa.resample(np.asarray(y, dtype=np.float32), orig_sr=native_sr, target_sr=int(sr))
        native_sr = int(sr)
    return np.ascontiguousarray(np.asarray(y, dtype=np.float32)), int(native_sr)


def save_audio(path: str | Path, audio: np.ndarray, sr: int) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), audio, sr)
    return path


def duration_of(path: str | Path) -> float:
    """Length in seconds. Probed cheaply, decoded only if it has to be.

    Same three tiers as load_stereo: this runs before any work is done, so a file the
    pipeline could actually handle must not be rejected here (and vice versa).
    """
    try:
        info = sf.info(str(path))
        if info.samplerate:
            return info.frames / info.samplerate
    except Exception:
        pass

    try:  # ffprobe: no decoding, reads the container header
        import json
        import subprocess

        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "json", str(path)],
            capture_output=True, text=True, timeout=120,
        )
        duration = (json.loads(probe.stdout or "{}").get("format") or {}).get("duration")
        if duration and float(duration) > 0:
            return float(duration)
    except Exception:
        pass

    try:
        import librosa

        return float(librosa.get_duration(path=str(path)))
    except Exception:
        pass

    y, sr = load_stereo(path)  # last resort: full decode (raises a clear error if unreadable)
    return len(y) / float(sr)


def is_silent(audio: np.ndarray, threshold: float = 1e-4) -> bool:
    """True when a stem carries no usable signal (e.g. vocals stem of an instrumental)."""
    return float(np.sqrt(np.mean(audio**2))) < threshold


# --- v2 helpers ------------------------------------------------------------------
# Separation and sample extraction work on STEREO, native-rate audio (the v1 pipeline
# collapsed everything to mono immediately and lost the stereo image of every stem).

def _ffmpeg_decode(path: Path) -> tuple[np.ndarray, int] | None:
    """Decode anything FFmpeg understands to float32 PCM. None if FFmpeg can't read it.

    The last-resort tier, and the only one that does not depend on a Python audio
    library's format support: ffmpeg is already a declared system dependency
    (packages.txt) and reads every container users actually upload.
    """
    import json
    import subprocess

    try:
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
             "stream=sample_rate,channels", "-of", "json", str(path)],
            capture_output=True, text=True, timeout=120,
        )
        stream = (json.loads(probe.stdout or "{}").get("streams") or [{}])[0]
        sr = int(stream.get("sample_rate") or 0)
        channels = int(stream.get("channels") or 0)
        if not sr or not channels:
            return None

        decode = subprocess.run(
            ["ffmpeg", "-v", "error", "-i", str(path), "-f", "f32le",
             "-acodec", "pcm_f32le", "-ac", str(channels), "-ar", str(sr), "-"],
            capture_output=True, timeout=900,
        )
        if decode.returncode != 0 or not decode.stdout:
            return None
        y = np.frombuffer(decode.stdout, dtype=np.float32)
        usable = (len(y) // channels) * channels
        return np.ascontiguousarray(y[:usable].reshape(-1, channels)), sr
    except Exception:
        return None


def load_stereo(path: str | Path) -> tuple[np.ndarray, int]:
    """Return (samples[n, channels], sr) at the file's native rate, always 2-D.

    Three tiers, because uploads are not the format their extension claims. libsndfile
    handles a fixed set of codecs, and a `.mp3` that is really AAC makes it fail with
    "Giving up searching valid MPEG header after 65536 bytes of junk" and then a
    misleading "File does not exist" — which is exactly how a real upload failed.

    FFmpeg comes BEFORE librosa deliberately. librosa's fallback is the deprecated
    audioread path, and on that same AAC-as-MP3 file it does something worse than fail:
    it returns 241 samples at 16 kHz for a 2-second 22.05 kHz file and reports success.
    Accepting that would separate and transcribe 15 ms of noise into a plausible-looking
    but meaningless bundle. FFmpeg decodes it correctly, so it is tried first and librosa
    is kept only for the case where FFmpeg is missing — with a length check either way.
    """
    path = Path(path)
    try:
        y, sr = sf.read(str(path), always_2d=True, dtype="float32")
        if y.size:
            return y, int(sr)
    except Exception:
        pass

    expected = _probe_duration(path)

    decoded = _ffmpeg_decode(path)
    if decoded is not None and _plausible(decoded, expected):
        return decoded

    try:
        import librosa

        y, sr = librosa.load(str(path), sr=None, mono=False)
        y = np.asarray(y, dtype=np.float32)
        if y.size:
            # librosa gives (channels, samples); the pipeline wants (samples, channels)
            y = y[:, None] if y.ndim == 1 else y.T
            candidate = (np.ascontiguousarray(y), int(sr))
            if _plausible(candidate, expected):
                return candidate
    except Exception:
        pass

    if decoded is not None and decoded[0].size:
        return decoded  # nothing agreed on the length, but this at least decoded

    raise RuntimeError(
        f"could not decode {path.name}: it is not audio in a format soundfile, FFmpeg or "
        "librosa can read (a truncated download or a renamed video file will do this)."
    )


def _plausible(decoded: tuple[np.ndarray, int], expected: float | None) -> bool:
    """Reject a decode that returned far less audio than the file actually contains."""
    y, sr = decoded
    if not y.size or not sr:
        return False
    if expected is None or expected <= 0:
        return True
    return (len(y) / sr) >= 0.9 * expected


def _probe_duration(path: Path) -> float | None:
    """Container duration via ffprobe (no decoding), or None."""
    import json
    import subprocess

    try:
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json",
             str(path)],
            capture_output=True, text=True, timeout=120,
        )
        value = (json.loads(probe.stdout or "{}").get("format") or {}).get("duration")
        return float(value) if value else None
    except Exception:
        return None


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
