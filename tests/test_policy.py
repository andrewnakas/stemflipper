"""Engine selection: which transcriber runs for which stem, and the fallbacks.

Uses stubs so no model is loaded — this is about the decision logic, not the engines.
"""

import numpy as np
import pytest

from stemflipper.transcription import policy


class _Char:
    def __init__(self, polyphonic=False, is_keys=False):
        self.polyphonic = polyphonic
        self.is_keys = is_keys


def _notes(pitches, step=0.5, dur=0.4):
    return [
        {"pitch": p, "start": round(i * step, 4), "end": round(i * step + dur, 4),
         "velocity": 90, "confidence": 0.8}
        for i, p in enumerate(pitches)
    ]


@pytest.fixture
def stub(monkeypatch):
    calls = {}

    def set_engine(name, result):
        calls[name] = result

    monkeypatch.setattr(policy.bp, "transcribe_pitched",
                        lambda path, stem, **kw: calls.get("bp", []))
    monkeypatch.setattr(policy.mono_pitch, "transcribe_mono",
                        lambda y, sr, stem: calls.get("mono", []))
    monkeypatch.setattr(policy.piano_mod, "transcribe_piano",
                        lambda path, device="cpu": calls.get("piano", []))
    monkeypatch.setattr(policy.drums_mod, "transcribe_drums_hier",
                        lambda sub, sr=None: calls.get("hier", []))
    monkeypatch.setattr(policy.drums_mod, "transcribe_drums",
                        lambda path: calls.get("flat", []))
    return set_engine


AUDIO = np.zeros(1000, dtype=np.float32)


def test_drums_prefer_the_split_kit(stub):
    stub("hier", _notes([36, 38, 42]))
    stub("flat", _notes([36]))
    out = policy.transcribe_track("drums", "x.wav", AUDIO, 22050, sub_stems={"kick": "k.wav"})
    assert out["engine"] == "drums_hier"
    assert out["is_drum"] is True
    assert len(out["notes"]) == 3


def test_drums_fall_back_when_the_kit_was_not_split(stub):
    stub("flat", _notes([36, 38]))
    out = policy.transcribe_track("drums", "x.wav", AUDIO, 22050, sub_stems=None)
    assert out["engine"] == "drums_heuristic"


def test_drums_fall_back_when_the_split_yields_nothing(stub):
    stub("hier", [])
    stub("flat", _notes([36]))
    out = policy.transcribe_track("drums", "x.wav", AUDIO, 22050, sub_stems={"kick": "k.wav"})
    assert out["engine"] == "drums_heuristic"
    assert out["fallback"] == "drums_hier"


def test_keys_use_the_piano_model(stub):
    stub("piano", _notes([60, 64, 67]))
    stub("bp", _notes([60]))
    out = policy.transcribe_track("other", "x.wav", AUDIO, 22050, character=_Char(is_keys=True))
    assert out["engine"] == "piano"
    assert len(out["notes"]) == 3


def test_keys_fall_back_to_basic_pitch_when_the_piano_model_is_empty(stub):
    stub("piano", [])
    stub("bp", _notes([60, 62]))
    out = policy.transcribe_track("other", "x.wav", AUDIO, 22050, character=_Char(is_keys=True))
    assert out["engine"] == "basic_pitch"
    assert "piano" in out["fallback"]


def test_bass_prefers_the_mono_track_when_it_agrees(stub):
    """Same line, but basic-pitch fragments it — the mono read is the better one."""
    stub("mono", _notes([33, 36, 38, 40]))
    stub("bp", _notes([33, 33, 36, 36, 38, 38, 40, 40], step=0.25, dur=0.2))
    out = policy.transcribe_track("bass", "x.wav", AUDIO, 22050, character=_Char())
    assert out["engine"] == "mono_pitch"
    assert len(out["notes"]) == 4


def test_bass_rejects_a_mono_track_that_lost_the_line(stub):
    stub("mono", _notes([33]))
    stub("bp", _notes([33, 36, 38, 40, 41, 43, 45, 47]))
    out = policy.transcribe_track("bass", "x.wav", AUDIO, 22050, character=_Char())
    assert out["engine"] == "basic_pitch"
    assert "mono_pitch" in out["fallback"]


def test_bass_octave_errors_are_corrected(stub):
    """basic-pitch's #1 bass failure: the whole line an octave (or more) out of range.

    The correction is a MINIMAL whole-line shift — intervals are preserved and the line
    lands inside a real bass register, rather than being nudged note by note.
    """
    stub("mono", [])
    stub("bp", _notes([9, 12, 14]))  # far below any real bass part
    out = policy.transcribe_track("bass", "x.wav", AUDIO, 22050, character=_Char())
    pitches = [n["pitch"] for n in out["notes"]]
    lo, hi = policy._BASS_MIDI_RANGE
    assert lo <= np.median(pitches) <= hi
    assert pitches == [21, 24, 26], "shift must be a whole number of octaves, minimal"
    assert np.diff(pitches).tolist() == [3, 2], "intervals must survive the correction"


def test_bass_in_range_is_left_alone(stub):
    stub("mono", [])
    stub("bp", _notes([33, 36, 38]))
    out = policy.transcribe_track("bass", "x.wav", AUDIO, 22050, character=_Char())
    assert [n["pitch"] for n in out["notes"]] == [33, 36, 38]


def test_polyphonic_vocals_use_basic_pitch(stub):
    """Harmony stacks are not monophonic; the f0 tracker would keep one voice only."""
    stub("mono", _notes([60, 62]))
    stub("bp", _notes([60, 64, 67, 62, 65, 69]))
    out = policy.transcribe_track("vocals", "x.wav", AUDIO, 22050, character=_Char(polyphonic=True))
    assert out["engine"] == "basic_pitch"


def test_other_stem_uses_basic_pitch(stub):
    stub("bp", _notes([60, 64]))
    out = policy.transcribe_track("other", "x.wav", AUDIO, 22050, character=_Char())
    assert out["engine"] == "basic_pitch"


def test_engine_failures_never_raise(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("model exploded")

    monkeypatch.setattr(policy.bp, "transcribe_pitched", boom)
    monkeypatch.setattr(policy.mono_pitch, "transcribe_mono", boom)
    monkeypatch.setattr(policy.drums_mod, "transcribe_drums", boom)
    monkeypatch.setattr(policy.drums_mod, "transcribe_drums_hier", boom)
    for stem in ("bass", "vocals", "other", "drums"):
        out = policy.transcribe_track(stem, "x.wav", AUDIO, 22050, character=_Char())
        assert out["notes"] == []
        assert "engine" in out


def test_agreement_metric():
    a = _notes([60, 62, 64])
    assert policy._agreement(a, a) == 1.0
    assert policy._agreement(a, _notes([72, 74, 76])) == 1.0  # octaves are the same class
    assert policy._agreement(a, _notes([61, 63, 65])) == 0.0
    assert policy._agreement(a, []) == 0.0
