"""ByteDance piano transcription (MIT) — SOTA on piano, used when a stem is keys."""

from __future__ import annotations

import logging
import tempfile
from pathlib import Path

log = logging.getLogger(__name__)

_PIANO_SR = 16000  # ByteDance model input rate
_PIANO = None
_PIANO_FAILED = False


def _get_piano_transcriptor(device: str = "cpu"):
    global _PIANO, _PIANO_FAILED
    if _PIANO_FAILED:
        raise RuntimeError("piano transcriptor unavailable")
    if _PIANO is None:
        try:
            from piano_transcription_inference import PianoTranscription

            _PIANO = PianoTranscription(device=device)
        except Exception as e:
            _PIANO_FAILED = True
            raise RuntimeError(f"piano transcriptor unavailable: {e}") from e
    return _PIANO


def transcribe_piano(audio_path: str | Path, device: str = "cpu") -> list[dict]:
    import librosa
    import pretty_midi

    transcriptor = _get_piano_transcriptor(device)
    audio, _ = librosa.load(str(audio_path), sr=_PIANO_SR, mono=True)
    with tempfile.NamedTemporaryFile(suffix=".mid", delete=False) as tmp:
        midi_path = tmp.name
    try:
        transcriptor.transcribe(audio, midi_path)
        midi = pretty_midi.PrettyMIDI(midi_path)
    finally:
        Path(midi_path).unlink(missing_ok=True)

    notes = []
    for instrument in midi.instruments:
        if instrument.is_drum:
            continue
        for n in instrument.notes:
            notes.append({
                "pitch": int(n.pitch),
                "start": round(float(n.start), 4),
                "end": round(float(n.end), 4),
                "velocity": int(n.velocity),
                "confidence": 0.9,  # 96.7% onset F1 on MAESTRO
            })
    return sorted(notes, key=lambda n: (n["start"], n["pitch"]))


def reset() -> None:
    global _PIANO, _PIANO_FAILED
    _PIANO = None
    _PIANO_FAILED = False
