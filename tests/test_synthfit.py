"""M5 synth-fit tests — mono+synth stem -> loadable Vital preset.

Gate: the fixture lead (mono_synth) stem yields a loadable .vital (valid JSON preset).
Warm-start needs no frontier dep; syntheon is an opt-in refiner and its absence is fine.
"""

import json

import numpy as np
import pytest
import soundfile as sf

from stemflipper import synthfit


def _load(path):
    y, sr = sf.read(str(path))
    if y.ndim > 1:
        y = y.mean(axis=1)
    return y.astype(np.float32), sr


def test_synth_fit_yields_loadable_vital(router_fixtures, tmp_path):
    """M5 GATE: mono synth stem -> a .vital preset that round-trips as JSON."""
    y, sr = _load(router_fixtures["paths"]["mono_synth"])
    fit = synthfit.synth_fit(y, sr)
    assert fit is not None
    assert fit.source == "warmstart"  # no syntheon opt-in
    path = synthfit.write_vital(fit.preset, tmp_path / "lead.vital")
    assert path.exists()
    loaded = json.loads(path.read_text())  # must be valid JSON ("loadable")
    assert loaded["synth_version"]
    assert "settings" in loaded
    # the warm-start actually set the parameters we estimate
    s = loaded["settings"]
    for key in ("osc_1_on", "filter_1_cutoff", "env_1_attack", "env_1_sustain", "env_1_release"):
        assert key in s


def test_warmstart_reflects_stem_character(router_fixtures):
    """A sustained synth reads a high sustain; a decaying pluck reads a lower one —
    the envelope is warm-started from the audio, not a fixed template."""
    y_synth, sr = _load(router_fixtures["paths"]["mono_synth"])
    y_pluck, _ = _load(router_fixtures["paths"]["mono_acoustic"])
    synth = synthfit.synth_fit(y_synth, sr)
    pluck = synthfit.synth_fit(y_pluck, sr)
    assert synth.scores["env_sustain"] > pluck.scores["env_sustain"]


def test_cutoff_tracks_brightness():
    """Brighter (higher-centroid) audio opens the filter further."""
    sr = 44100
    t = np.arange(sr) / sr
    dull = np.sin(2 * np.pi * 220 * t).astype(np.float32)
    bright = np.sin(2 * np.pi * 4000 * t).astype(np.float32)
    c_dull = synthfit.synth_fit(dull, sr).scores["cutoff_norm"]
    c_bright = synthfit.synth_fit(bright, sr).scores["cutoff_norm"]
    assert c_bright > c_dull


def test_synth_fit_silent_returns_none():
    assert synthfit.synth_fit(np.zeros(16000, dtype=np.float32), 16000) is None


def test_synth_fit_syntheon_falls_back_when_absent(router_fixtures):
    """Opting into syntheon when it isn't installed must silently fall back to the
    warm-start, never raise (Invariant #4)."""
    y, sr = _load(router_fixtures["paths"]["mono_synth"])
    fit = synthfit.synth_fit(y, sr, use_syntheon=True)
    assert fit is not None
    assert fit.source in ("warmstart", "syntheon")  # syntheon absent => warmstart


def test_cutoff_to_vital_midi_range():
    assert synthfit._cutoff_to_vital_midi(0.0) == pytest.approx(8.0)
    assert synthfit._cutoff_to_vital_midi(1.0) == pytest.approx(136.0)
    mid = synthfit._cutoff_to_vital_midi(0.5)
    assert 8.0 < mid < 136.0
