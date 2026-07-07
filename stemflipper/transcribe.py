"""Per-stem transcription to note events.

Notes are plain dicts {pitch, start, end, velocity} — JSON-friendly, no cross-module types.
Pitched stems: basic-pitch (Apache-2.0, TFLite/CoreML — CPU-fast).
Keys/piano stems: ByteDance piano_transcription_inference (MIT, SOTA 96.7% onset F1,
CPU-OK) when the router flags the stem as keys; falls back to basic-pitch on any failure.
Drums: librosa onset detection + spectral-band heuristic -> GM map (known-weak on
overlapping hits; the honest MVP baseline per PLAN.md; ADT upgrade is out for licensing).
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import numpy as np

GM_KICK, GM_SNARE, GM_HAT = 36, 38, 42

_PIANO_SR = 16000  # ByteDance model input rate

# fmin/fmax clamps per stem type; bass clamp kills the #1 failure mode (octave errors)
_PITCH_RANGES = {
    "bass": (30.0, 350.0),
    "vocals": (60.0, 1500.0),
}


def _onnx_model_path():
    """The basic-pitch ICASSP-2022 model in ONNX form, or None if unavailable.

    We FORCE the ONNX backend rather than let basic-pitch auto-pick. Its default
    priority is tf > coreml > tflite > onnx, and on Linux (the Space) `tflite-runtime`
    is pulled in as a transitive dep of basic-pitch — but tflite-runtime's wheels are
    compiled against numpy 1.x and hard-crash under numpy 2.x (`_ARRAY_API not found`),
    which silently zeroed every pitched stem (drums survived because they don't use
    basic-pitch). onnxruntime is numpy-2 clean. Passing the .onnx path explicitly
    sidesteps the whole backend-priority problem. Adding `onnxruntime` to requirements
    was necessary but NOT sufficient — tflite still won the priority race.
    """
    try:
        from basic_pitch import FilenameSuffix, build_icassp_2022_model_path

        return build_icassp_2022_model_path(FilenameSuffix.onnx)
    except Exception:
        return None


def transcribe_pitched(audio_path: str | Path, stem_name: str = "other") -> list[dict]:
    from basic_pitch.inference import predict

    fmin, fmax = _PITCH_RANGES.get(stem_name, (None, None))
    kwargs = {}
    if fmin is not None:
        kwargs = {"minimum_frequency": fmin, "maximum_frequency": fmax}
    onnx_path = _onnx_model_path()
    if onnx_path is not None:
        kwargs["model_or_model_path"] = onnx_path
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


# module-level cache: the ~150 MB ByteDance checkpoint loads at most once per process
_PIANO = None
_PIANO_FAILED = False


def _get_piano_transcriptor():
    global _PIANO, _PIANO_FAILED
    if _PIANO is not None or _PIANO_FAILED:
        return _PIANO
    try:
        from piano_transcription_inference import PianoTranscription

        _PIANO = PianoTranscription(device="cpu")
    except Exception:
        _PIANO_FAILED = True  # no network / no weights — caller falls back to basic-pitch
    return _PIANO


def transcribe_piano(audio_path: str | Path) -> list[dict]:
    """ByteDance high-resolution piano transcription. Writes to a temp MIDI internally,
    then parses it to the standard note-dict format. Raises on any failure so the caller
    can fall back to basic-pitch."""
    import librosa
    import pretty_midi

    transcriptor = _get_piano_transcriptor()
    if transcriptor is None:
        raise RuntimeError("piano transcriptor unavailable")

    audio, _ = librosa.load(str(audio_path), sr=_PIANO_SR, mono=True)
    with tempfile.NamedTemporaryFile(suffix=".mid", delete=True) as tmp:
        transcriptor.transcribe(audio, tmp.name)
        pm = pretty_midi.PrettyMIDI(tmp.name)

    notes = []
    for inst in pm.instruments:
        if inst.is_drum:
            continue
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
        low_ratio = float(mag[freqs < 150].sum() / total)
        high_ratio = float(mag[freqs > 5000].sum() / total)
        # a coincident hat adds ~0.4 high-band ratio, so only near-pure HF is a hat
        if low_ratio > 0.25:
            pitch = GM_KICK
        elif high_ratio > 0.7:
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


def transcribe_stem(stem_name: str, audio_path: str | Path, is_keys: bool = False) -> dict:
    """Return {"notes": [...], "is_drum": bool}. Never raises on empty/unpitched audio.

    is_keys (set by the router for piano/organ stems) routes to the ByteDance piano
    transcriber, falling back to basic-pitch if it's unavailable or produces nothing.
    """
    is_drum = stem_name == "drums"
    if is_drum:
        try:
            notes = transcribe_drums(audio_path)
        except Exception:
            notes = []
        return {"notes": notes, "is_drum": True}

    notes = []
    if is_keys:
        try:
            notes = transcribe_piano(audio_path)
        except Exception:
            notes = []
    if not notes:  # not-keys, or piano model unavailable/empty -> basic-pitch
        try:
            notes = transcribe_pitched(audio_path, stem_name)
        except Exception:
            notes = []
    return {"notes": notes, "is_drum": False}
