"""Monophonic pitch tracking -> notes (bass and lead vocal lines).

basic-pitch is a polyphonic model; on a single-voice stem it emits octave ghosts and
fragments held notes. Tracking a continuous f0 and segmenting it is both more accurate
and gives the sampler/synth stages a true root frequency per note.
"""

import numpy as np
import pytest

from stemflipper.transcription.mono_pitch import (
    f0_to_notes,
    hz_to_midi,
    pyin_f0,
    transcribe_mono,
)

SR = 22050


def _tone(pitch, dur, sr=SR, vibrato_cents=0.0, gain=1.0):
    n = int(dur * sr)
    t = np.arange(n) / sr
    # f must be a full per-sample array: a scalar here collapses the cumsum to a single
    # element and the "tone" becomes a constant with no pitch at all.
    f = np.full(n, 440.0 * 2 ** ((pitch - 69) / 12))
    if vibrato_cents:
        f = f * (1 + (vibrato_cents / 1200.0) * np.sin(2 * np.pi * 5 * t))
    phase = 2 * np.pi * np.cumsum(f) / sr
    sig = 0.6 * np.sin(phase) + 0.25 * np.sin(2 * phase) + 0.1 * np.sin(3 * phase)
    env = np.minimum(1.0, np.linspace(0, 20, n)) * np.exp(-np.linspace(0, 1.2, n))
    return (sig * env * gain).astype(np.float32)


def _melody(pitches, dur=0.45, gap=0.05, **kw):
    parts = []
    for p in pitches:
        parts.append(_tone(p, dur, **kw))
        parts.append(np.zeros(int(gap * SR), dtype=np.float32))
    return np.concatenate(parts)


def test_recovers_a_scale_exactly():
    pitches = [45, 47, 48, 50, 52, 53, 55, 57]
    notes = transcribe_mono(_melody(pitches), SR, "vocals")
    assert len(notes) == len(pitches)
    assert [n["pitch"] for n in notes] == pitches


def test_vibrato_stays_inside_one_note():
    """A 60-cent vibrato must not shatter a held note into a dozen fragments."""
    notes = transcribe_mono(_melody([57], dur=1.2, vibrato_cents=60), SR, "vocals")
    assert len(notes) == 1
    assert notes[0]["end"] - notes[0]["start"] > 1.0


def test_a_real_pitch_change_starts_a_new_note():
    y = np.concatenate([_tone(60, 0.6), _tone(64, 0.6)])  # no gap, 4 semitones apart
    notes = transcribe_mono(y, SR, "vocals")
    assert len(notes) == 2
    assert [n["pitch"] for n in notes] == [60, 64]


def test_silence_between_notes_separates_them():
    notes = transcribe_mono(_melody([60, 60], gap=0.2), SR, "vocals")
    assert len(notes) == 2


def test_bass_range_is_tracked():
    pitches = [33, 36, 38]  # A1, C2, D2 — the fixture's riff
    notes = transcribe_mono(_melody(pitches, dur=0.6), SR, "bass")
    assert [n["pitch"] for n in notes] == pitches


def test_velocity_follows_amplitude():
    y = np.concatenate([
        _tone(60, 0.5, gain=1.0), np.zeros(int(0.1 * SR), dtype=np.float32),
        _tone(60, 0.5, gain=0.2),
    ])
    notes = transcribe_mono(y, SR, "vocals")
    assert len(notes) == 2
    assert notes[0]["velocity"] > notes[1]["velocity"] + 15


def test_notes_carry_confidence_and_positive_duration():
    notes = transcribe_mono(_melody([60, 62]), SR, "vocals")
    assert notes
    for n in notes:
        assert 0.0 < n["confidence"] <= 1.0
        assert n["end"] > n["start"]
        assert 0 <= n["pitch"] <= 127


def test_silence_yields_nothing():
    assert transcribe_mono(np.zeros(SR, dtype=np.float32), SR, "vocals") == []
    assert pyin_f0(np.zeros(SR, dtype=np.float32), SR) is None


def test_no_note_is_shorter_than_the_floor():
    """Sub-note artefacts must not become notes. The tracker's analysis window smears a
    very short blip, so the contract is the minimum LENGTH, not zero output."""
    from stemflipper.transcription.mono_pitch import _MIN_NOTE_S

    y = np.concatenate([_tone(60, 0.02), np.zeros(int(0.3 * SR), dtype=np.float32)])
    for n in transcribe_mono(y, SR, "vocals"):
        assert n["end"] - n["start"] >= _MIN_NOTE_S


def test_wide_vibrato_still_holds_one_note():
    """+-100 cents is ordinary operatic vibrato, not eight separate notes."""
    notes = transcribe_mono(_melody([57], dur=1.2, vibrato_cents=100), SR, "vocals")
    assert len(notes) <= 2


def test_f0_to_notes_handles_an_empty_track():
    assert f0_to_notes({}) == []
    assert f0_to_notes({"f0": np.array([]), "conf": np.array([]), "hop_s": 0.01}) == []


def test_hz_to_midi_is_correct():
    assert hz_to_midi(np.array([440.0]))[0] == pytest.approx(69.0)
    assert hz_to_midi(np.array([220.0]))[0] == pytest.approx(57.0)
