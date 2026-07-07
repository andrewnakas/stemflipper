"""Effects reconstruction — EQ-match + blind reverb IR (M5, best-effort).

Philosophy per PLAN.md §4: **match a target, never invert an unknown chain.**
For every stem we estimate a small, DAW-portable effect description:

    EQ     — a parametric-ish curve fit to the stem's own spectral envelope, so a
             flat sampler/synth render can be nudged toward the stem's tone. Emitted
             as (freq, gain_dB) breakpoints — maps onto any DAW graphic/parametric EQ.
    Reverb — a blind impulse-response estimate (decaying-tail energy → exponential IR
             whose RT60 matches the stem's measured decay). Emitted as a mono .wav IR
             for convolution reverb, plus the scalar RT60.

Both are computed with numpy/scipy only (already in the dep set) so this stage never
needs a network or a frontier install. Every public function is wrapped so a failure
returns None and the pipeline falls back to the dry sampler path (Invariants #4, #7).

auraloss (optional) is used only to *verify* an EQ match improved spectral distance
(the M5 gate); its absence never breaks the stage.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

# --- EQ fit ---------------------------------------------------------------------
_EQ_BANDS_HZ = (
    31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000,
)  # ISO 1/3-ish octave centers — the breakpoints we report
_EQ_MAX_GAIN_DB = 18.0      # clamp so a near-silent band can't explode the curve
_EQ_REF_HZ = 1000.0         # curve is normalized to 0 dB at this pivot

# --- reverb IR ------------------------------------------------------------------
_IR_MAX_S = 1.5             # cap the exported IR length
_RT60_FLOOR_S = 0.05        # below this we treat the stem as effectively dry
_RT60_CEIL_S = 3.0


@dataclass
class StemEffects:
    eq_curve: list[tuple[float, float]]   # [(freq_hz, gain_db)] normalized to 0 dB @ 1 kHz
    rt60_s: float                         # estimated reverb decay time (0.0 => dry)
    wet: bool                             # router's dry/wet flag, carried through
    ir_wav: str | None = None             # bundle-relative path to the exported IR wav, if any
    scores: dict = field(default_factory=dict)


# --------------------------------------------------------------------------- EQ

def _band_envelope_db(y: np.ndarray, sr: int) -> np.ndarray:
    """Mean magnitude (dB) in each _EQ_BANDS_HZ band over voiced frames.

    Normalized so the reference band (1 kHz) sits at 0 dB. Returns one value per band.
    """
    import librosa

    S = np.abs(librosa.stft(y, n_fft=2048))
    rms = librosa.feature.rms(S=S)[0]
    peak = float(rms.max()) or 1.0
    voiced = rms > 0.15 * peak
    if not voiced.any():
        voiced = np.ones_like(rms, dtype=bool)
    mag = S[:, voiced].mean(axis=1)              # mean magnitude per FFT bin
    freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)

    edges = _band_edges(sr)
    band_db = np.zeros(len(_EQ_BANDS_HZ))
    for i, (lo, hi) in enumerate(edges):
        sel = (freqs >= lo) & (freqs < hi)
        e = float(mag[sel].mean()) if sel.any() else 1e-9
        band_db[i] = 20.0 * np.log10(max(e, 1e-9))
    return band_db


def _band_edges(sr: int) -> list[tuple[float, float]]:
    """Half-octave edges around each band center, clamped to Nyquist."""
    nyq = sr / 2.0
    edges = []
    for c in _EQ_BANDS_HZ:
        edges.append((c / np.sqrt(2), min(c * np.sqrt(2), nyq)))
    return edges


def fit_eq(y: np.ndarray, sr: int) -> list[tuple[float, float]]:
    """Fit a per-band EQ curve to the stem's spectral envelope.

    Returns [(freq_hz, gain_db)] normalized to 0 dB at 1 kHz and clamped to
    ±_EQ_MAX_GAIN_DB. This describes the stem's tonal balance so a flat render can be
    EQ'd toward it. Bands above Nyquist are dropped.
    """
    if not len(y) or float(np.abs(y).max()) < 1e-6:
        return []
    band_db = _band_envelope_db(y, sr)
    # normalize to the reference band
    ref_idx = int(np.argmin([abs(c - _EQ_REF_HZ) for c in _EQ_BANDS_HZ]))
    band_db = band_db - band_db[ref_idx]
    band_db = np.clip(band_db, -_EQ_MAX_GAIN_DB, _EQ_MAX_GAIN_DB)

    nyq = sr / 2.0
    return [
        (float(c), round(float(g), 2))
        for c, g in zip(_EQ_BANDS_HZ, band_db)
        if c < nyq
    ]


def match_eq(source: np.ndarray, target: np.ndarray, sr: int) -> list[tuple[float, float]]:
    """Corrective EQ curve that morphs `source`'s spectrum toward `target`'s.

    This is the true "match a target" filter (PLAN.md §4): per band, the gain is
    target_dB − source_dB, so applying it to `source` flattens the tonal difference.
    Used to color a flat sampler/synth render toward the original stem. Clamped and
    normalized at 1 kHz like fit_eq; empty on degenerate input.
    """
    if not len(source) or not len(target):
        return []
    if float(np.abs(source).max()) < 1e-6 or float(np.abs(target).max()) < 1e-6:
        return []
    src_db = _band_envelope_db(source, sr)
    tgt_db = _band_envelope_db(target, sr)
    diff = tgt_db - src_db
    ref_idx = int(np.argmin([abs(c - _EQ_REF_HZ) for c in _EQ_BANDS_HZ]))
    diff = diff - diff[ref_idx]
    diff = np.clip(diff, -_EQ_MAX_GAIN_DB, _EQ_MAX_GAIN_DB)
    nyq = sr / 2.0
    return [
        (float(c), round(float(g), 2))
        for c, g in zip(_EQ_BANDS_HZ, diff)
        if c < nyq
    ]


def eq_curve_to_fir(curve: list[tuple[float, float]], sr: int, numtaps: int = 511) -> np.ndarray:
    """Turn an (freq, gain_dB) EQ curve into a linear-phase FIR kernel (firwin2).

    Used to *render* the EQ (for the gate's auraloss check and for anyone applying the
    curve without a DAW). Returns a unit-DC-safe kernel; a trivial/empty curve yields a
    single-tap identity.
    """
    from scipy.signal import firwin2

    if not curve:
        return np.array([1.0])
    nyq = sr / 2.0
    freqs = [0.0] + [f for f, _ in curve] + [nyq]
    gains_db = [curve[0][1]] + [g for _, g in curve] + [curve[-1][1]]
    gains = [10.0 ** (g / 20.0) for g in gains_db]
    # firwin2 needs strictly increasing, normalized [0,1] frequencies
    norm = np.clip(np.array(freqs) / nyq, 0.0, 1.0)
    norm[0], norm[-1] = 0.0, 1.0
    norm, keep = _dedupe_increasing(norm)
    gains = [gains[i] for i in keep]
    taps = firwin2(numtaps, norm, gains)
    return taps


def _dedupe_increasing(x: np.ndarray) -> tuple[np.ndarray, list[int]]:
    """Drop non-increasing points (firwin2 requires strictly increasing freqs)."""
    out, keep, last = [], [], -1.0
    for i, v in enumerate(x):
        if v > last:
            out.append(v)
            keep.append(i)
            last = v
    return np.array(out), keep


# ------------------------------------------------------------------------ reverb

def estimate_rt60(y: np.ndarray, sr: int) -> float:
    """Blind RT60 estimate from the stem's *final release tail*.

    Schroeder integration assumes a decaying source, so running it over a whole piece of
    sustained music (whose EDC is nearly flat until the end) extrapolates to a bogus huge
    RT60. Instead we isolate the tail after the last strong onset — the part of the signal
    that behaves like a reverb decay — and fit its log-RMS slope over the −5…−35 dB span,
    extrapolating to −60 dB. Returns 0.0 for effectively dry stems.
    """
    import librosa

    if not len(y) or float(np.abs(y).max()) < 1e-6:
        return 0.0
    hop = 512
    rms = librosa.feature.rms(y=y, hop_length=hop)[0]
    if len(rms) < 4:
        return 0.0
    peak = float(rms.max()) or 1.0

    # the tail = from the last frame at ≥40% of peak (last strong onset) to the end
    strong = np.where(rms >= 0.4 * peak)[0]
    if not len(strong):
        return 0.0
    tail = rms[strong[-1]:]
    if len(tail) < 3:
        return 0.0

    tail_db = 20.0 * np.log10(np.maximum(tail / peak, 1e-6))
    # fit only the monotone-ish decay window −5…−35 dB below peak
    idx = np.where((tail_db <= -5.0) & (tail_db >= -35.0))[0]
    if len(idx) < 3:
        return 0.0
    t = idx * hop / sr
    slope = np.polyfit(t, tail_db[idx], 1)[0]   # dB/s (negative for a decay)
    if slope >= -1.0:                            # too shallow => not a real tail
        return 0.0
    rt60 = -60.0 / slope
    if rt60 < _RT60_FLOOR_S:
        return 0.0
    return float(min(rt60, _RT60_CEIL_S))


def synth_ir(rt60_s: float, sr: int) -> np.ndarray:
    """Build a decaying-noise impulse response with the given RT60.

    A pragmatic stand-in for a blindly-captured RIR (PLAN.md prefers convolution over
    inverting reverb knobs): exponentially-decaying white noise, RT60 = time to −60 dB.
    Deterministic (fixed seed) so exports are reproducible.
    """
    if rt60_s <= 0.0:
        return np.array([1.0], dtype=np.float32)
    n = int(min(rt60_s, _IR_MAX_S) * sr)
    if n < 2:
        return np.array([1.0], dtype=np.float32)
    t = np.arange(n) / sr
    decay = 10.0 ** (-3.0 * t / rt60_s)           # −60 dB at t = rt60
    noise = np.random.RandomState(0).randn(n)
    ir = (noise * decay).astype(np.float32)
    ir /= max(1e-9, float(np.abs(ir).max()))       # normalize the diffuse tail to ≤1
    ir[0] = 1.0                                    # direct impulse dominates (set last)
    return ir


# ------------------------------------------------------------------- orchestration

def analyze_effects(y: np.ndarray, sr: int, wet: bool) -> StemEffects | None:
    """Full best-effort effect analysis for one stem. Never raises; returns None on
    total failure so the caller falls back to the dry path."""
    try:
        curve = fit_eq(y, sr)
        # RT60 is only trustworthy on stems the router judged actually reverberant: the
        # Schroeder slope of a dry-but-sustained tone extrapolates to a bogus huge decay,
        # so a dry stem gets rt60=0 (=> no IR written) regardless of its raw slope.
        rt60 = estimate_rt60(y, sr) if wet else 0.0
        return StemEffects(
            eq_curve=curve,
            rt60_s=round(rt60, 3),
            wet=bool(wet),
            scores={
                "n_eq_bands": len(curve),
                "eq_span_db": round(
                    (max(g for _, g in curve) - min(g for _, g in curve)) if curve else 0.0, 2
                ),
            },
        )
    except Exception:
        return None


def render_eq(y: np.ndarray, curve: list[tuple[float, float]], sr: int) -> np.ndarray:
    """Apply an EQ curve to audio via the FIR kernel (for gate verification / preview)."""
    from scipy.signal import fftconvolve

    taps = eq_curve_to_fir(curve, sr)
    if len(taps) <= 1:
        return y
    out = fftconvolve(y, taps, mode="same")
    return out.astype(y.dtype)


def eq_improves_match(dry: np.ndarray, target: np.ndarray, sr: int) -> bool | None:
    """M5 gate: does a *match* EQ from `dry`→`target` reduce multi-res STFT distance?

    Fits the corrective curve internally (match_eq), applies it to `dry`, and compares
    auraloss to `target` before vs after. Returns True/False, or None if auraloss isn't
    installed (so the gate can be skipped offline without failing). Never raises.
    """
    try:
        import torch
        from auraloss.freq import MultiResolutionSTFTLoss
    except Exception:
        return None
    try:
        loss = MultiResolutionSTFTLoss()
        curve = match_eq(dry, target, sr)
        eqd = render_eq(dry, curve, sr)

        def t(x):
            x = np.asarray(x, dtype=np.float32)
            return torch.from_numpy(x)[None, None, :]

        n = min(len(dry), len(target), len(eqd))
        before = float(loss(t(dry[:n]), t(target[:n])))
        after = float(loss(t(eqd[:n]), t(target[:n])))
        return after < before
    except Exception:
        return None
