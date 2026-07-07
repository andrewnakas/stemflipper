"""M5 effects tests — EQ-match + blind reverb IR.

Gate: an EQ-matched render decreases auraloss (multi-res STFT) vs the target. All
functions must degrade gracefully (never raise) on silent / degenerate input.
"""

import numpy as np
import pytest
import soundfile as sf

from stemflipper import effects


def _load(path):
    y, sr = sf.read(str(path))
    if y.ndim > 1:
        y = y.mean(axis=1)
    return y.astype(np.float32), sr


# ------------------------------------------------------------------------- EQ fit

def test_fit_eq_returns_curve_normalized_at_1k(router_fixtures):
    y, sr = _load(router_fixtures["paths"]["mono_acoustic"])
    curve = effects.fit_eq(y, sr)
    assert curve, "expected a non-empty EQ curve for a pitched stem"
    # every band is (freq, gain_db) and gains are clamped
    for f, g in curve:
        assert f > 0
        assert abs(g) <= effects._EQ_MAX_GAIN_DB + 1e-6
    # the 1 kHz reference band sits at ~0 dB
    ref = min(curve, key=lambda fg: abs(fg[0] - 1000.0))
    assert abs(ref[1]) < 1e-6


def test_fit_eq_silent_is_empty():
    y = np.zeros(16000, dtype=np.float32)
    assert effects.fit_eq(y, 16000) == []


def test_eq_curve_to_fir_identity_on_empty():
    taps = effects.eq_curve_to_fir([], 44100)
    assert taps.shape == (1,)
    assert taps[0] == 1.0


# ------------------------------------------------------------- the gate: auraloss

def test_match_eq_targets_the_difference(router_fixtures):
    """A match EQ from a tilted copy back to the original is the inverse tilt: it should
    boost the highs that the tilt cut (positive gain in the top band)."""
    from scipy.signal import fftconvolve, firwin2

    y, sr = _load(router_fixtures["paths"]["mono_acoustic"])
    tilt = firwin2(255, [0.0, 0.2, 1.0], [1.0, 1.0, 0.2])  # cuts highs
    dry = fftconvolve(y, tilt, mode="same").astype(np.float32)
    curve = effects.match_eq(dry, y, sr)
    assert curve
    top = max(curve, key=lambda fg: fg[0])
    assert top[1] > 0, f"expected a high-band boost to undo the tilt, got {top}"


def test_eq_match_decreases_auraloss(router_fixtures):
    """M5 GATE: a match EQ from a spectrally-tilted 'dry' render toward the target stem
    reduces multi-resolution STFT distance. Skips only if auraloss isn't installed."""
    from scipy.signal import fftconvolve, firwin2

    y, sr = _load(router_fixtures["paths"]["mono_acoustic"])
    tilt = firwin2(255, [0.0, 0.2, 1.0], [1.0, 1.0, 0.2])  # tonally-wrong dry render
    dry = fftconvolve(y, tilt, mode="same").astype(np.float32)

    improved = effects.eq_improves_match(dry, y, sr)
    if improved is None:
        pytest.skip("auraloss not installed — gate check skipped offline")
    assert improved is True


# ------------------------------------------------------------------------- reverb

def test_estimate_rt60_zero_on_silence():
    assert effects.estimate_rt60(np.zeros(16000, dtype=np.float32), 16000) == 0.0


def test_estimate_rt60_recovers_known_decay(router_fixtures):
    """A dry pluck convolved with a known-RT60 IR reads back a decay of the right order
    (blind estimate is coarse — assert it's in a plausible band, not exact)."""
    from scipy.signal import fftconvolve

    y, sr = _load(router_fixtures["paths"]["mono_acoustic"])
    ir = effects.synth_ir(1.5, sr)
    wet = fftconvolve(y, ir, mode="full")[: len(y) + len(ir)].astype(np.float32)
    wet /= max(1e-9, np.abs(wet).max())
    est = effects.estimate_rt60(wet, sr)
    assert 0.5 <= est <= effects._RT60_CEIL_S


def test_synth_ir_has_direct_impulse_and_decays():
    sr = 44100
    ir = effects.synth_ir(0.8, sr)
    assert len(ir) > 1
    assert ir[0] == pytest.approx(1.0, abs=1e-6)  # direct impulse normalized to 1
    # late energy is far below the impulse
    assert np.abs(ir[-100:]).mean() < 0.3


def test_synth_ir_dry_is_unit_impulse():
    ir = effects.synth_ir(0.0, 44100)
    assert ir.shape == (1,)
    assert ir[0] == 1.0


# --------------------------------------------------------- orchestration / degrade

def test_analyze_effects_dry_stem_no_reverb(router_fixtures):
    """A stem the router flagged dry gets rt60=0 (no bogus IR), regardless of slope."""
    y, sr = _load(router_fixtures["paths"]["mono_synth"])
    fx = effects.analyze_effects(y, sr, wet=False)
    assert fx is not None
    assert fx.rt60_s == 0.0
    assert fx.eq_curve  # still gets an EQ curve


def test_analyze_effects_never_raises_on_garbage():
    fx = effects.analyze_effects(np.zeros(4, dtype=np.float32), 44100, wet=True)
    # empty/degenerate: returns a well-formed StemEffects (or None), never raises
    assert fx is None or fx.rt60_s == 0.0
