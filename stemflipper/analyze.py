"""Song-level analysis: tempo, beat grid, key."""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

# Krumhansl-Schmuckler key profiles (Krumhansl & Kessler 1982).
_MAJOR_PROFILE = np.array(
    [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
)
_MINOR_PROFILE = np.array(
    [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
)
_PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


@dataclass
class Analysis:
    tempo: float
    beat_times: list[float]
    key: str
    duration: float
    time_signature: str = "4/4"
    sr: int = 44100


def estimate_tempo(y: np.ndarray, sr: int) -> tuple[float, list[float]]:
    import librosa

    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
    bpm = float(np.atleast_1d(tempo)[0])
    # octave-error sanity clamp: prefer 70-180 BPM (see PLAN.md quantization pitfalls)
    while bpm and bpm < 70:
        bpm *= 2
    while bpm > 180:
        bpm /= 2
    beat_times = librosa.frames_to_time(beat_frames, sr=sr).tolist()
    return bpm, beat_times


def estimate_key(y: np.ndarray, sr: int) -> str:
    import librosa

    chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
    if chroma.max() <= 0:
        return "unknown"
    best_score, best_key = -np.inf, "unknown"
    for tonic in range(12):
        rotated = np.roll(chroma, -tonic)
        for profile, mode in ((_MAJOR_PROFILE, "major"), (_MINOR_PROFILE, "minor")):
            score = np.corrcoef(rotated, profile)[0, 1]
            if score > best_score:
                best_score, best_key = score, f"{_PITCH_NAMES[tonic]} {mode}"
    return best_key


def analyze_audio(y: np.ndarray, sr: int) -> Analysis:
    tempo, beat_times = estimate_tempo(y, sr)
    return Analysis(
        tempo=round(tempo, 2),
        beat_times=beat_times,
        key=estimate_key(y, sr),
        duration=len(y) / sr,
        sr=sr,
    )
