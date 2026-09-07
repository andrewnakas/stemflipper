"""Drum transcription.

Two engines:

*   ``transcribe_drums`` — the v1 baseline: one onset track over the whole kit, classified
    into kick/snare/hat by spectral band. Documented-weak on overlapping hits, kept as the
    fallback when the kit was not split.
*   ``transcribe_drums_hier`` — v2: run onset detection on each SEPARATED kit piece from
    DrumSep. Overlapping hits stop being a problem (a kick and a hat in the same 10 ms are
    simply two onsets in two different signals), and the GM map gets real toms, ride,
    crash and an open/closed hi-hat distinction. This is the accuracy that ADT models are
    usually needed for, reached instead through separation — which keeps the licensing
    clean (ADTOF and friends are CC-BY-NC and stay out, Invariant #3).
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

log = logging.getLogger(__name__)

GM_KICK, GM_SNARE, GM_HAT = 36, 38, 42
GM_HAT_OPEN = 46
GM_TOM_LOW, GM_TOM_MID, GM_TOM_HIGH = 45, 47, 50
GM_RIDE, GM_CRASH, GM_CRASH_2 = 51, 49, 57

#: per-piece onset sensitivity and how long a hit is allowed to ring
#: `delta` is a multiple of the MEDIAN onset strength of that piece's own hits (see the
#: two-pass reference in _onsets). Swept against the fixture's known pattern
#: (kick 16 / snare 16 / hat 64) on REAL DrumSep output, cross-checked on sparse
#: synthetic tracks so the numbers are not overfitted to one density:
#:   kick  0.40 -> 16/16 found, 16 emitted (exact; flat 0.15-0.60, sparse 8/8)
#:   hh    0.50 -> 64/64 found, 64 emitted (exact; flat 0.40-0.60)
#:   snare 0.50 -> 14/16 found, 26 emitted. A higher bar scores better ON THIS FIXTURE
#:                 (2.6 -> 15/16, 17 emitted) but erases hits on a CLEANLY separated
#:                 snare (8/8 -> 0/8 on a synthetic one), so it is overfitted to this
#:                 mix's hat bleed. Downstream cleanup.dedup_notes removes most of the
#:                 excess; losing real snares would be unrecoverable.
PIECE_PARAMS: dict[str, dict] = {
    "kick":   {"delta": 0.40, "wait_s": 0.06, "window_s": 0.30, "max_len_s": 0.25},
    "snare":  {"delta": 0.50, "wait_s": 0.05, "window_s": 0.25, "max_len_s": 0.25},
    "toms":   {"delta": 0.80, "wait_s": 0.06, "window_s": 0.40, "max_len_s": 0.60},
    "hh":     {"delta": 0.50, "wait_s": 0.02, "window_s": 0.20, "max_len_s": 0.25},
    "ride":   {"delta": 0.80, "wait_s": 0.06, "window_s": 0.80, "max_len_s": 1.00},
    "crash":  {"delta": 0.80, "wait_s": 0.12, "window_s": 1.50, "max_len_s": 1.50},
}
_DEFAULT_PARAMS = {"delta": 0.80, "wait_s": 0.05, "window_s": 0.30, "max_len_s": 0.30}

#: an onset in a quiet piece this close to a loud kick/snare hit is bleed, not a hit
_BLEED_WINDOW_S = 0.02
_BLEED_DB = 12.0

_HAT_OPEN_DECAY_S = 0.15

#: A kit-piece channel this far below the loudest piece is separation residue, not a part
#: the drummer played. Measured on a real DrumSep run over a kick/snare/hat-only fixture:
#: the played pieces landed within 13 dB of the loudest, the three absent ones 47-50 dB
#: below. Without this gate DrumSep's empty ride/crash/tom channels produce hundreds of
#: phantom notes on any song that does not use them.
_PIECE_PRESENT_DB = 30.0
_PIECE_ABS_FLOOR_DB = -60.0

#: Within one piece, a hit this far below that piece's typical (90th-percentile) hit is
#: bleed from another piece rather than a stroke on this one.
_HIT_FLOOR_DB = 15.0


def _present_pieces(loaded: dict[str, tuple]) -> dict[str, tuple]:
    """Drop kit channels that hold only separation residue."""
    levels = {
        name: (20 * np.log10(float(np.sqrt(np.mean(np.square(y))))) if np.any(y) else -120.0)
        for name, (y, _) in loaded.items()
    }
    if not levels:
        return {}
    loudest = max(levels.values())
    kept = {}
    for name, (y, sr) in loaded.items():
        db = levels[name]
        if db < loudest - _PIECE_PRESENT_DB or db < _PIECE_ABS_FLOOR_DB:
            log.info("drum piece %s is residue (%.1f dB, %.1f below loudest) — skipped",
                     name, db, loudest - db)
            continue
        kept[name] = (y, sr)
    return kept


#: Silence prepended before onset detection. peak_pick needs `pre_max`/`pre_avg` frames
#: of history to call something a peak, so a hit at exactly t=0 — a song that starts on
#: the downbeat, which is most of them — is otherwise invisible. The pad is subtracted
#: back off the detected times.
_LEAD_IN_S = 0.12


def _onsets(y: np.ndarray, sr: int, delta: float, wait_s: float):
    import librosa

    hop = 256
    # Pad a WHOLE number of hops: a fractional pad shifts every analysis frame off the
    # sample grid it would otherwise use, which perturbs the onset envelope enough to
    # lose quiet hits (measured: 8 of 64 hi-hats on a real DrumSep run).
    pad = int(np.ceil(_LEAD_IN_S * sr / hop)) * hop
    lead_s = pad / sr
    padded = np.concatenate([np.zeros(pad, dtype=y.dtype), y])
    env = librosa.onset.onset_strength(y=padded, sr=sr, hop_length=hop)
    if not len(env) or float(env.max()) <= 0:
        return np.array([]), env, hop, pad / sr
    # Two-pass threshold. A single global statistic is not a usable reference: the
    # envelope MAXIMUM is inflated by the lead-in transient (which cost 33 of 64 hi-hats),
    # and a high PERCENTILE swings with how densely the piece is played (fine on real
    # audio, far too high on a sparse track where 84% of frames are silent).
    # So: pick permissively once, take the MEDIAN STRENGTH OF THOSE PEAKS as "a typical
    # hit on this piece", then re-pick relative to that. It adapts to both.
    wait = max(1, int(wait_s * sr / hop))
    rough = librosa.util.peak_pick(
        env, pre_max=3, post_max=3, pre_avg=8, post_avg=8,
        delta=0.02 * float(env.max()), wait=wait,
    )
    ref = float(np.median(env[rough])) if len(rough) else float(env.max())
    peaks = librosa.util.peak_pick(
        env, pre_max=3, post_max=3, pre_avg=8, post_avg=8,
        delta=delta * max(ref, 1e-9), wait=wait,
    )
    times = librosa.frames_to_time(peaks, sr=sr, hop_length=hop) - lead_s
    keep = times >= -0.01
    return np.clip(times[keep], 0.0, None), env, hop, lead_s


def _decay_time(seg: np.ndarray, sr: int, drop_db: float = 30.0) -> float:
    """Seconds from the hit's peak until it falls `drop_db` below it."""
    if not len(seg):
        return 0.0
    env = np.abs(seg)
    peak = float(env.max())
    if peak <= 1e-6:
        return 0.0
    floor = peak * (10.0 ** (-drop_db / 20.0))
    below = np.nonzero(env < floor)[0]
    # first sustained drop, not a single zero crossing
    for idx in below:
        if idx + int(0.005 * sr) < len(env) and float(env[idx : idx + int(0.005 * sr)].max()) < floor:
            return float(idx) / sr
    return float(len(seg)) / sr


def _tom_pitches(centroids: list[float]) -> list[int]:
    """Split tom hits into up to three GM toms by pitch, low to high."""
    if not centroids:
        return []
    vals = np.array(centroids, dtype=float)
    if len(vals) < 3 or float(vals.max() / max(vals.min(), 1e-6)) < 1.25:
        return [GM_TOM_MID] * len(vals)  # one audible tom, don't invent a kit
    lo, hi = np.percentile(vals, [33, 67])
    return [GM_TOM_LOW if v <= lo else (GM_TOM_HIGH if v >= hi else GM_TOM_MID) for v in vals]


def _piece_hits(name: str, y: np.ndarray, sr: int) -> list[dict]:
    """Onsets of one kit piece -> notes with per-piece GM pitch and velocity scaling."""
    import librosa

    params = PIECE_PARAMS.get(name, _DEFAULT_PARAMS)
    times, env, hop, lead_s = _onsets(y, sr, params["delta"], params["wait_s"])
    if not len(times):
        return []

    window = int(params["window_s"] * sr)
    peaks_db, feats = [], []
    for t in times:
        i = int(t * sr)
        seg = y[i : i + window]
        if len(seg) < int(0.005 * sr):
            peaks_db.append(-120.0)
            feats.append((0.0, 0.0))
            continue
        peak = float(np.abs(seg).max())
        peaks_db.append(20 * np.log10(peak) if peak > 1e-6 else -120.0)
        centroid = float(
            librosa.feature.spectral_centroid(y=seg.astype(np.float32), sr=sr).mean()
        ) if peak > 1e-6 else 0.0
        feats.append((centroid, _decay_time(seg, sr)))

    peaks_db = np.array(peaks_db)
    audible = peaks_db > -60.0
    if not audible.any():
        return []
    lo, hi = np.percentile(peaks_db[audible], [5, 95])
    span = max(hi - lo, 1e-6)
    # bleed guard within the piece: a stroke far below this piece's typical hit is another
    # piece leaking in (a hat transient showing up in the snare channel, say)
    audible &= peaks_db > (hi - _HIT_FLOOR_DB)
    if not audible.any():
        return []

    tom_pitches = (
        _tom_pitches([c for (c, _), ok in zip(feats, audible) if ok]) if name == "toms" else []
    )
    tom_i = 0
    env_max = float(env.max()) or 1.0

    notes = []
    for t, db, (centroid, decay), ok in zip(times, peaks_db, feats, audible):
        if not ok:
            continue
        if name == "hh":
            pitch = GM_HAT_OPEN if decay > _HAT_OPEN_DECAY_S else GM_HAT
        elif name == "toms":
            pitch = tom_pitches[tom_i] if tom_i < len(tom_pitches) else GM_TOM_MID
            tom_i += 1
        elif name == "kick":
            pitch = GM_KICK
        elif name == "snare":
            pitch = GM_SNARE
        elif name == "ride":
            pitch = GM_RIDE
        elif name == "crash":
            pitch = GM_CRASH
        else:
            pitch = GM_SNARE
        velocity = int(np.clip(30 + 97 * (db - lo) / span, 1, 127))
        length = float(np.clip(decay, 0.03, params["max_len_s"]))
        frame = min(int((t + lead_s) * sr / hop), len(env) - 1)
        notes.append({
            "pitch": pitch,
            "start": round(float(t), 4),
            "end": round(float(t) + length, 4),
            "velocity": velocity,
            "confidence": round(float(np.clip(env[frame] / env_max, 0.05, 1.0)), 3),
            "_piece": name,
            "_peak_db": float(db),
        })
    return notes


def _drop_bleed(notes: list[dict]) -> list[dict]:
    """Drop a quiet hit that coincides with a much louder one in another piece.

    DrumSep leaves some kick in the snare channel and vice versa; those bleed transients
    would otherwise become phantom notes on every backbeat.
    """
    loud = [n for n in notes if n["_piece"] in ("kick", "snare")]
    if not loud:
        return notes
    kept = []
    for n in notes:
        if n["_piece"] in ("kick", "snare"):
            kept.append(n)
            continue
        masked = any(
            abs(n["start"] - m["start"]) <= _BLEED_WINDOW_S
            and n["_peak_db"] < m["_peak_db"] - _BLEED_DB
            for m in loud
        )
        if not masked:
            kept.append(n)
    return kept


def transcribe_drums_hier(sub_stems: dict[str, Path], sr: int | None = None) -> list[dict]:
    """Per-piece drum transcription from separated kit stems."""
    import librosa

    loaded: dict[str, tuple] = {}
    for name, path in (sub_stems or {}).items():
        if name == "drums_other":
            continue
        try:
            y, piece_sr = librosa.load(str(path), sr=sr, mono=True)
            if len(y) and float(np.abs(y).max()) >= 1e-4:
                loaded[name] = (y, piece_sr)
        except Exception:
            log.exception("drum piece %s failed to load", name)

    notes: list[dict] = []
    for name, (y, piece_sr) in _present_pieces(loaded).items():
        try:
            notes.extend(_piece_hits(name, y, piece_sr))
        except Exception:
            log.exception("drum piece %s failed", name)
    notes = _drop_bleed(notes)
    for n in notes:
        n.pop("_piece", None)
        n.pop("_peak_db", None)
    return sorted(notes, key=lambda n: (n["start"], n["pitch"]))


def transcribe_drums(audio_path: str | Path) -> list[dict]:
    """v1 baseline: whole-kit onsets classified by spectral band (kick/snare/hat)."""
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
        notes.append({
            "pitch": pitch,
            "start": round(float(t), 4),
            "end": round(float(t) + 0.1, 4),
            "velocity": velocity,
            "confidence": 0.6,
        })
    return notes
