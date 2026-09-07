"""Isolating, trimming and grading individual hits for one-shot sample extraction.

The v1 sampler took one slice per MIDI pitch straight from the stem: no isolation check,
no zero-crossing trim, no fades, no normalisation, no de-duplication. The slices carried
whatever else was playing at that moment. These helpers produce sample-library-grade
one-shots instead.
"""

from __future__ import annotations

import numpy as np

_FADE_IN_S = 0.002
_FADE_OUT_S = 0.02
_ZERO_SEARCH_S = 0.005
_TARGET_PEAK_DB = -1.0
_DEDUP_SIMILARITY = 0.97


def zero_cross_snap(y: np.ndarray, index: int, search_s: float = _ZERO_SEARCH_S, sr: int = 44100) -> int:
    """Nearest zero crossing to `index` — starting a sample mid-cycle clicks."""
    span = int(search_s * sr)
    lo = max(0, index - span)
    hi = min(len(y) - 1, index + span)
    if hi <= lo:
        return max(0, min(index, len(y) - 1))
    seg = y[lo:hi]
    crossings = np.nonzero(np.diff(np.signbit(seg)))[0]
    if not len(crossings):
        return index
    return int(lo + crossings[np.argmin(np.abs(crossings + lo - index))])


def decay_end(y: np.ndarray, sr: int, start: int, drop_db: float = 50.0, max_s: float = 2.0) -> int:
    """Where a hit has decayed `drop_db` below its peak (or `max_s`, whichever first)."""
    end = min(len(y), start + int(max_s * sr))
    seg = np.abs(y[start:end])
    if not len(seg):
        return end
    peak = float(seg.max())
    if peak <= 1e-6:
        return start
    floor = peak * (10.0 ** (-drop_db / 20.0))
    win = max(1, int(0.01 * sr))
    for i in range(0, len(seg) - win, win):
        if float(seg[i : i + win].max()) < floor:
            return start + i
    return end


def fade(y: np.ndarray, sr: int, fade_in_s: float = _FADE_IN_S, fade_out_s: float = _FADE_OUT_S) -> np.ndarray:
    out = np.array(y, dtype=np.float32, copy=True)
    n_in = min(int(fade_in_s * sr), len(out) // 2)
    n_out = min(int(fade_out_s * sr), len(out) // 2)
    if n_in > 0:
        out[:n_in] *= np.linspace(0.0, 1.0, n_in, dtype=np.float32)
    if n_out > 0:
        out[-n_out:] *= np.linspace(1.0, 0.0, n_out, dtype=np.float32)
    return out


def normalize_peak(y: np.ndarray, target_db: float = _TARGET_PEAK_DB) -> np.ndarray:
    peak = float(np.abs(y).max()) if len(y) else 0.0
    if peak <= 1e-9:
        return np.asarray(y, dtype=np.float32)
    target = 10.0 ** (target_db / 20.0)
    return np.asarray(y * (target / peak), dtype=np.float32)


#: Another piece bleeding into a sample only matters if it is comparably LOUD. A hi-hat
#: 20 dB under a kick is inaudible in the kick one-shot; another kick is not.
BLEED_MARGIN_DB = 6.0


def is_isolated(
    onset_s: float,
    others: dict[str, list[float]],
    self_piece: str,
    window_s: float,
    guard_s: float = 0.03,
    levels_db: dict[str, float] | None = None,
    self_level_db: float | None = None,
) -> bool:
    """True when nothing loud enough to contaminate this hit fires alongside it.

    Requiring literal silence from the rest of the kit is unusable on real music: a kick
    and a hi-hat land together on most beats, so a strict test rejected EVERY kick (0 of
    16 on the fixture) and the kit came out with one sample in it. What matters is
    relative level — a quiet piece under a loud one does not spoil the sample.
    """
    for piece, times in (others or {}).items():
        if piece == self_piece:
            continue
        near = any(-guard_s <= (t - onset_s) <= window_s for t in times)
        if not near:
            continue
        if levels_db is not None and self_level_db is not None:
            other_db = levels_db.get(piece)
            if other_db is not None and other_db < self_level_db - BLEED_MARGIN_DB:
                continue  # audible, but far below this hit: harmless
        return False
    return True


def _mfcc_mean(y: np.ndarray, sr: int) -> np.ndarray:
    """Timbre fingerprint: mean MFCCs 1..12, standardised.

    MFCC[0] is overall loudness and dominates the vector, so including it makes every
    normalised fingerprint look alike — a 200 Hz tone and a burst of high noise scored
    0.987 cosine similarity, and de-duplication threw away genuinely different takes.
    """
    import librosa

    if len(y) < int(0.02 * sr):
        return np.zeros(12)
    mfcc = librosa.feature.mfcc(y=np.asarray(y, dtype=np.float32), sr=sr, n_mfcc=13)
    feat = mfcc[1:].mean(axis=1)
    std = float(np.std(feat))
    return (feat - float(np.mean(feat))) / (std if std > 1e-9 else 1.0)


def dedupe(samples: list[dict], sr: int, threshold: float = _DEDUP_SIMILARITY) -> list[dict]:
    """Drop near-identical takes; a round-robin set wants variety, not copies."""
    kept: list[dict] = []
    feats: list[np.ndarray] = []
    for s in sorted(samples, key=lambda s: -float(np.abs(s["audio"]).max() or 0)):
        f = _mfcc_mean(s["audio"], sr)
        norm = np.linalg.norm(f)
        if norm < 1e-9:
            continue
        f = f / norm
        if any(float(np.dot(f, g)) > threshold for g in feats):
            continue
        kept.append(s)
        feats.append(f)
    return kept


def extract_hit(
    y: np.ndarray,
    sr: int,
    onset_s: float,
    next_onset_s: float | None = None,
    max_len_s: float = 2.0,
) -> np.ndarray | None:
    """One clean, trimmed, faded, normalised one-shot starting at `onset_s`."""
    start = zero_cross_snap(y, max(0, int((onset_s - 0.005) * sr)), sr=sr)
    end = decay_end(y, sr, start, max_s=max_len_s)
    if next_onset_s is not None:
        end = min(end, int((next_onset_s - 0.01) * sr))
    end = min(end, len(y))
    if end - start < int(0.01 * sr):
        return None
    seg = np.asarray(y[start:end], dtype=np.float32)
    if float(np.abs(seg).max()) < 1e-5:
        return None
    return normalize_peak(fade(seg, sr))


def is_isolated_hit(
    onset_s: float,
    onsets: dict[str, list[float]],
    hit_levels: dict[str, dict[float, float]],
    self_piece: str,
    window_s: float,
    self_level_db: float,
    guard_s: float = 0.03,
) -> bool:
    """Isolation judged hit-by-hit rather than piece-by-piece.

    Compares the level of the specific colliding stroke against this one, so a quiet
    hi-hat under a loud kick is tolerated while a second kick is not.
    """
    for piece, times in (onsets or {}).items():
        if piece == self_piece:
            continue
        levels = (hit_levels or {}).get(piece, {})
        for t in times:
            if not (-guard_s <= (t - onset_s) <= window_s):
                continue
            other_db = levels.get(round(float(t), 4))
            if other_db is None or other_db >= self_level_db - BLEED_MARGIN_DB:
                return False
    return True
