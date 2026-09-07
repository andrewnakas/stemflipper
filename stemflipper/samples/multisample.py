"""Build a multisampled instrument from a pitched stem.

v1 kept one slice per distinct MIDI pitch — longest note wins, no pitch verification, no
velocity layers, no loop points, and any neighbouring note bled straight into the sample.
This picks CLEAN, ISOLATED, pitch-VERIFIED notes, adds velocity layers where the playing
warrants them, and finds loop points for sustained material so a held key doesn't just
stop when the sample runs out.
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

from .. import audio_io
from . import hits as hits_mod

log = logging.getLogger(__name__)

MAX_ZONES = 24
MAX_LAYERS = 2
_MIN_NOTE_S = 0.12
_MAX_CENTS_ERROR = 50.0
_ROOT_SPACING = 3          # aim for a sampled root at least every 3 semitones
_LOOP_ERROR_MAX = 0.05


def _midi_to_hz(pitch: float) -> float:
    return 440.0 * 2.0 ** ((pitch - 69) / 12.0)


def _verify_pitch(seg: np.ndarray, sr: int, pitch: int) -> tuple[float, float] | None:
    """(cents error, voiced fraction) measured over the middle of the note, or None."""
    import librosa

    if len(seg) < int(0.05 * sr):
        return None
    a, b = int(0.2 * len(seg)), int(0.8 * len(seg))
    mid = seg[a:b] if b > a + int(0.03 * sr) else seg
    expected = _midi_to_hz(pitch)
    # We already know the pitch we expect, so search a narrow band around it and size the
    # analysis frame to fit at least two periods of the low edge. With the default 2048
    # frame and a wide band, every note below ~60 Hz failed outright — which silently cost
    # the bass its lowest samples (A1 = 55 Hz produced no zone at all).
    # A two-octave band: narrower than this and pyin's Viterbi transition matrix is wider
    # than the number of pitch bins, which raises and (being wrapped) silently verified
    # nothing at all.
    fmin = max(20.0, expected / 2.0)
    fmax = min(sr / 2 - 100, expected * 2.0)
    if fmax <= fmin:
        return None
    frame_length = int(2 ** np.ceil(np.log2(max(2048, 4 * sr / fmin))))
    if len(mid) < frame_length:
        frame_length = int(2 ** np.floor(np.log2(max(512, len(mid)))))
        if frame_length < 4 * sr / fmin:
            return None
    try:
        f0, voiced, _ = librosa.pyin(
            np.asarray(mid, dtype=np.float32),
            fmin=fmin, fmax=fmax, sr=sr, frame_length=frame_length,
        )
    except Exception:
        return None
    good = np.isfinite(f0)
    if not good.any():
        return None
    measured = float(np.nanmedian(f0[good]))
    cents = 1200.0 * np.log2(max(measured, 1e-6) / expected)
    return float(cents), float(good.mean())


def find_loop(seg: np.ndarray, sr: int, pitch: int) -> dict | None:
    """Loop points for sustained material: a period-aligned span that repeats cleanly."""
    period = sr / max(_midi_to_hz(pitch), 1e-6)
    if period < 4 or len(seg) < int(0.5 * sr):
        return None
    win = int(2 * period)
    lo = int(0.4 * len(seg))
    hi = int(0.9 * len(seg))
    best = None
    for a in range(lo, max(lo + 1, hi - win), max(1, int(period))):
        ref = seg[a : a + win]
        if len(ref) < win:
            break
        denom = float(np.sum(ref ** 2)) or 1e-9
        for cycles in (8, 16, 32, 64):
            b = a + int(cycles * period)
            if b + win > len(seg):
                break
            err = float(np.sum((ref - seg[b : b + win]) ** 2)) / denom
            if best is None or err < best[0]:
                best = (err, a, b)
    if best is None or best[0] > _LOOP_ERROR_MAX:
        return None
    _, a, b = best
    return {"start": int(a), "end": int(b), "crossfade": int(min(2 * period, 0.01 * sr))}


def build_multisample(
    stem_name: str,
    y: np.ndarray,
    sr: int,
    notes: list[dict],
    out_dir: str | Path,
    amp_env: dict | None = None,
    sustained: bool = False,
) -> dict | None:
    """Write instruments/<stem>/{samples/*.wav, instrument.json}; return the dict or None."""
    if not notes or y is None or not len(y):
        return None
    out_dir = Path(out_dir)
    samples_dir = out_dir / "samples"

    ordered = sorted(notes, key=lambda n: n["start"])
    starts = np.array([n["start"] for n in ordered])
    ends = np.array([n["end"] for n in ordered])

    candidates: dict[int, list[dict]] = {}
    for i, n in enumerate(ordered):
        dur = n["end"] - n["start"]
        if dur < _MIN_NOTE_S or n.get("confidence", 1.0) < 0.5:
            continue
        # isolation: no other note overlapping this one
        overlaps = (starts < n["end"] - 1e-6) & (ends > n["start"] + 1e-6)
        if int(overlaps.sum()) > 1:
            continue
        a = int(n["start"] * sr)
        b = min(len(y), int((n["end"] + 0.05) * sr))
        seg = np.asarray(y[a:b], dtype=np.float32)
        if len(seg) < int(0.05 * sr) or float(np.abs(seg).max()) < 1e-4:
            continue
        verified = _verify_pitch(seg, sr, n["pitch"])
        if verified is None:
            continue
        cents, voiced = verified
        if abs(cents) > _MAX_CENTS_ERROR or voiced < 0.8:
            continue
        rms = np.sqrt(np.mean(seg.astype(float) ** 2))
        score = dur * (1 - abs(cents) / _MAX_CENTS_ERROR) * float(voiced)
        candidates.setdefault(int(n["pitch"]), []).append({
            "audio": seg, "score": score, "peak_db": 20 * np.log10(float(np.abs(seg).max())),
            "rms": rms, "dur": dur, "pitch": int(n["pitch"]),
        })

    if not candidates:
        return None

    roots = sorted(candidates)
    if len(roots) > MAX_ZONES:
        keep = np.linspace(0, len(roots) - 1, MAX_ZONES).astype(int)
        roots = [roots[i] for i in sorted(set(keep.tolist()))]

    zones: list[dict] = []
    for idx, pitch in enumerate(roots):
        takes = sorted(candidates[pitch], key=lambda c: -c["score"])
        peaks = [c["peak_db"] for c in takes]
        layers = 1
        if len(takes) >= 3 and (max(peaks) - min(peaks)) > 8.0:
            layers = MAX_LAYERS
        chosen = takes[:layers]
        bands = [(0, 127)] if layers == 1 else [(0, 63), (64, 127)]
        # quietest take is the low-velocity layer
        chosen = sorted(chosen, key=lambda c: c["peak_db"])
        lo_key = 0 if idx == 0 else (roots[idx - 1] + pitch) // 2 + 1
        hi_key = 127 if idx == len(roots) - 1 else (pitch + roots[idx + 1]) // 2
        for layer_i, (cand, (lovel, hivel)) in enumerate(zip(chosen, bands)):
            audio = hits_mod.normalize_peak(hits_mod.fade(cand["audio"], sr, 0.003, 0.03))
            name = f"{stem_name}_{pitch:03d}_v{layer_i + 1}.wav"
            audio_io.write_wav24(samples_dir / name, audio, sr)
            loop = find_loop(audio, sr, pitch) if sustained else None
            zones.append({
                "path": f"instruments/{stem_name}/samples/{name}",
                "root": int(pitch), "lo": int(lo_key), "hi": int(hi_key),
                "lovel": int(lovel), "hivel": int(hivel), "rr": 0,
                "gain_db": 0.0, "loop": loop,
            })

    if not zones:
        return None
    return {
        "type": "multisample",
        "name": stem_name,
        "amp_env": amp_env or {"a": 0.005, "d": 0.1, "s": 1.0, "r": 0.25},
        "zones": zones,
    }
