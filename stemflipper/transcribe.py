"""Per-stem transcription — facade over `stemflipper.transcription`.

Kept so `from stemflipper import transcribe` and the v1 entry points still work (tests
monkeypatch `transcribe.transcribe_piano`, so `transcribe_stem` must call the name
through this module rather than importing it into a local).

Notes are plain dicts {pitch, start, end, velocity, confidence}.
"""

from __future__ import annotations

from pathlib import Path

from .transcription import policy as _policy
from .transcription.basic_pitch import THRESHOLDS, _onnx_model_path, transcribe_pitched
from .transcription.drums import (
    GM_CRASH, GM_HAT, GM_HAT_OPEN, GM_KICK, GM_RIDE, GM_SNARE,
    transcribe_drums, transcribe_drums_hier,
)
from .transcription.mono_pitch import f0_to_notes, pyin_f0, transcribe_mono
from .transcription.piano import transcribe_piano

__all__ = [
    "transcribe_stem", "transcribe_track", "transcribe_pitched", "transcribe_piano",
    "transcribe_drums", "transcribe_drums_hier", "transcribe_mono", "pyin_f0",
    "f0_to_notes", "THRESHOLDS", "_onnx_model_path",
    "GM_KICK", "GM_SNARE", "GM_HAT", "GM_HAT_OPEN", "GM_RIDE", "GM_CRASH",
]


def transcribe_track(*args, **kwargs) -> dict:
    return _policy.transcribe_track(*args, **kwargs)


def transcribe_stem(stem_name: str, audio_path: str | Path, is_keys: bool = False) -> dict:
    """v1 entry point: {"notes": [...], "is_drum": bool}. Never raises."""
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
            # module-level lookup on purpose: tests monkeypatch transcribe.transcribe_piano
            notes = globals()["transcribe_piano"](audio_path)
        except Exception:
            notes = []
    if not notes:
        try:
            notes = transcribe_pitched(audio_path, stem_name)
        except Exception:
            notes = []
    return {"notes": notes, "is_drum": False}
