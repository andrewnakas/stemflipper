"""Per-stem transcription to note events.

Notes are plain dicts {pitch, start, end, velocity} — JSON-friendly, no cross-module types.
Pitched stems: basic-pitch (Apache-2.0, TFLite/CoreML — CPU-fast).
Drums: librosa onset detection + spectral-band heuristic -> GM map (known-weak on
overlapping hits; the honest MVP baseline per PLAN.md; ADT upgrade is out for licensing).
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

GM_KICK, GM_SNARE, GM_HAT = 36, 38, 42

# fmin/fmax clamps per stem type; bass clamp kills the #1 failure mode (octave errors)
_PITCH_RANGES = {
    "bass": (30.0, 350.0),
    "vocals": (60.0, 1500.0),
}


def transcribe_pitched(audio_path: str | Path, stem_name: str = "other") -> list[dict]:
    from basic_pitch.inference import predict

    fmin, fmax = _PITCH_RANGES.get(stem_name, (None, None))
    kwargs = {}
    if fmin is not None:
        kwargs = {"minimum_frequency": fmin, "maximum_frequency": fmax}
    _, midi_data, _ = predict(str(audio_path), **kwargs)

    notes = []
    for inst in midi_data.instruments:
        for n in inst.notes:
            notes.append(
                {
                    "pitch": int(n.pitch),
                    "start": round(float(n.start), 4),
                    "end": round(float(n.end), 4),
                    "velocity": int(n.velocity),
                }
            )
    notes.sort(key=lambda n: (n["start"], n["pitch"]))
    return notes


def transcribe_drums(audio_path: str | Path) -> list[dict]:
    import librosa

    y, sr = librosa.load(str(audio_path), sr=None, mono=True)
    if not len(y):
        return []
    onset_times = librosa.onset.onset_detect(
        y=y, sr=sr, units="time", backtrack=False, delta=0.05
    )
    window = int(0.05 * sr)
    freqs = np.fft.rfftfreq(window, 1 / sr)
    peak = float(np.abs(y).max()) or 1.0

    notes = []
    for t in onset_times:
        i = int(t * sr)
        seg = y[i : i + window]
        if len(seg) < window // 2 or np.abs(seg).max() < 1e-4:
            continue
        mag = np.abs(np.fft.rfft(seg, n=window))
        total = mag.sum() or 1.0
        centroid = float((freqs * mag).sum() / total)
        low_ratio = float(mag[freqs < 150].sum() / total)
        if low_ratio > 0.25:
            pitch = GM_KICK
        elif centroid > 4000:
            pitch = GM_HAT
        else:
            pitch = GM_SNARE
        velocity = int(np.clip(np.abs(seg).max() / peak * 127, 20, 127))
        notes.append(
            {
                "pitch": pitch,
                "start": round(float(t), 4),
                "end": round(float(t) + 0.1, 4),
                "velocity": velocity,
            }
        )
    return notes


def transcribe_stem(stem_name: str, audio_path: str | Path) -> dict:
    """Return {"notes": [...], "is_drum": bool}. Never raises on empty/unpitched audio."""
    is_drum = stem_name == "drums"
    try:
        notes = transcribe_drums(audio_path) if is_drum else transcribe_pitched(audio_path, stem_name)
    except Exception:
        notes = []
    return {"notes": notes, "is_drum": is_drum}
