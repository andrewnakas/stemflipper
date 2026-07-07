"""Router test matrix — the M4 gate.

Runs offline by default (use_panns=False): the router must pick the right strategy
from spectral cues alone, so CI never needs the 340 MB PANNs checkpoint. A separate
opt-in test exercises the real PANNs classifier when the weights are already cached.
"""

import numpy as np
import pytest
import soundfile as sf

from stemflipper import router, transcribe


def _load(path):
    y, sr = sf.read(str(path))
    if y.ndim > 1:
        y = y.mean(axis=1)
    return y.astype(np.float32), sr


# --------------------------------------------------------------- the routing matrix

EXPECTED = {
    "mono_synth": "synth-fit",       # monophonic + sustained/synth-like
    "mono_acoustic": "sampler",      # monophonic + decaying/acoustic
    "poly_chord": "sampler-phrase",  # polyphonic -> can't be per-note reconstructed
}


@pytest.mark.parametrize("name,expected", list(EXPECTED.items()))
def test_router_strategy_matrix(router_fixtures, name, expected):
    y, sr = _load(router_fixtures["paths"][name])
    notes = transcribe.transcribe_pitched(router_fixtures["paths"][name], "other")
    char = router.route_stem("other", y, sr, notes, use_panns=False)
    assert char.strategy == expected, (
        f"{name}: got {char.strategy!r} (expected {expected!r}); scores={char.scores}"
    )


def test_polyphony_separates_mono_from_chords(router_fixtures):
    mono, sr = _load(router_fixtures["paths"]["mono_synth"])
    chord, _ = _load(router_fixtures["paths"]["poly_chord"])
    assert router.polyphony_estimate(mono, sr) < router._POLY_CHROMA_BINS
    assert router.polyphony_estimate(chord, sr) > router._POLY_CHROMA_BINS


def test_sustain_separates_synth_from_acoustic(router_fixtures):
    synth, sr = _load(router_fixtures["paths"]["mono_synth"])
    acoustic, _ = _load(router_fixtures["paths"]["mono_acoustic"])
    # sustained tone holds its energy; plucked/acoustic decays away
    assert router.sustain_ratio(synth, sr) >= router._SUSTAIN_SYNTH
    assert router.sustain_ratio(acoustic, sr) < router._SUSTAIN_SYNTH


def test_note_overlap_ignores_octave_ghosts():
    # two notes an octave apart overlapping in time is NOT real polyphony
    octave = [
        {"pitch": 60, "start": 0.0, "end": 1.0, "velocity": 100},
        {"pitch": 72, "start": 0.1, "end": 0.9, "velocity": 100},
    ]
    assert router.note_overlap_fraction(octave) == 0.0
    # a real chord (major third) does count
    chord = [
        {"pitch": 60, "start": 0.0, "end": 1.0, "velocity": 100},
        {"pitch": 64, "start": 0.0, "end": 1.0, "velocity": 100},
    ]
    assert router.note_overlap_fraction(chord) > 0.3


# ---------------------------------------------------------------- stem-name priors

def test_drums_always_route_to_sampler(router_fixtures):
    # drums bypass instrument routing entirely (one-shot sampler), even given a chord stem
    y, sr = _load(router_fixtures["paths"]["poly_chord"])
    char = router.route_stem("drums", y, sr, [], use_panns=False)
    assert char.strategy == "sampler"
    assert char.polyphonic is False


def test_bass_never_routes_to_phrase(router_fixtures):
    # bass is monophonic by construction; chroma smear must not send it to sampler-phrase
    y, sr = _load(router_fixtures["paths"]["poly_chord"])  # deliberately a chord
    char = router.route_stem("bass", y, sr, [], use_panns=False)
    assert char.strategy != "sampler-phrase"
    assert char.polyphonic is False


# ----------------------------------------------------------- graceful degradation

def test_silent_stem_routes_without_raising():
    y = np.zeros(32000, dtype=np.float32)
    char = router.route_stem("other", y, 32000, [], use_panns=False)
    assert char.strategy in ("sampler", "synth-fit", "sampler-phrase")
    assert char.polyphonic is False


def test_escalate_polyphony_promotes_borderline(router_fixtures):
    # a mono reading with a borderline chroma + heavy real-note overlap escalates to poly
    y, sr = _load(router_fixtures["paths"]["mono_acoustic"])
    char = router.route_stem("other", y, sr, [], use_panns=False)
    assert char.strategy == "sampler"
    # force borderline chroma so the note-overlap rule can act
    char.scores["poly_chroma"] = router._POLY_CHROMA_BINS - 0.1
    chord_notes = [
        {"pitch": 60, "start": 0.0, "end": 2.0, "velocity": 100},
        {"pitch": 64, "start": 0.0, "end": 2.0, "velocity": 100},
        {"pitch": 67, "start": 0.0, "end": 2.0, "velocity": 100},
    ]
    escalated = router.escalate_polyphony(char, chord_notes, "other")
    assert escalated.polyphonic is True
    assert escalated.strategy == "sampler-phrase"


# --------------------------------------------------- real PANNs (opt-in, cached only)

def test_panns_classifies_when_cached(router_fixtures):
    """Exercise the real PANNs classifier only if its checkpoint is already downloaded,
    so CI stays offline. classify_instrument must never raise regardless."""
    y, sr = _load(router_fixtures["paths"]["poly_chord"])
    label, idx, conf = router.classify_instrument(y, sr)
    # always returns a well-formed triple; ("unknown", -1, 0.0) when weights absent
    assert isinstance(label, str)
    assert isinstance(idx, int)
    assert 0.0 <= conf <= 1.0
    if idx >= 0:  # weights were present and inference ran
        assert conf > 0.0
