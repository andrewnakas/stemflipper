"""Silence-bounded phrase chops, mainly for vocals.

A vocal take is most useful as phrases, not as a single 4-minute file: this cuts at the
breaths and labels each chop with its pitch range so it can be filed and re-pitched.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from .. import audio_io
from . import hits as hits_mod

MIN_PHRASE_S = 0.6
MAX_PHRASE_S = 20.0
MAX_PHRASES = 24
_GAP_S = 0.35
_SILENCE_DB = -45.0


def chop_phrases(
    stem_name: str,
    y: np.ndarray,
    sr: int,
    notes: list[dict],
    out_dir: str | Path,
    max_phrases: int = MAX_PHRASES,
) -> list[dict]:
    """Write phrases/<stem>_<nn>_<lo>-<hi>.wav; return their manifest entries."""
    if y is None or not len(y):
        return []
    out_dir = Path(out_dir)

    hop = max(1, int(0.02 * sr))
    frames = int(np.ceil(len(y) / hop))
    padded = np.pad(np.asarray(y, dtype=float), (0, frames * hop - len(y)))
    env = np.sqrt(np.mean(padded.reshape(frames, hop) ** 2, axis=1))
    peak = float(env.max()) or 1e-9
    loud = env > peak * (10 ** (_SILENCE_DB / 20.0))
    if not loud.any():
        return []

    spans, start, gap = [], None, 0
    gap_frames = max(1, int(_GAP_S / 0.02))
    for i, ok in enumerate(loud):
        if ok:
            if start is None:
                start = i
            gap = 0
        elif start is not None:
            gap += 1
            if gap >= gap_frames:
                spans.append((start, i - gap + 1))
                start = None
    if start is not None:
        spans.append((start, len(loud)))

    written: list[dict] = []
    for a_f, b_f in spans:
        a_s, b_s = a_f * 0.02, b_f * 0.02
        if not (MIN_PHRASE_S <= b_s - a_s <= MAX_PHRASE_S):
            continue
        a, b = int(a_s * sr), min(len(y), int(b_s * sr))
        seg = hits_mod.fade(np.asarray(y[a:b], dtype=np.float32), sr, 0.005, 0.02)
        inside = [n["pitch"] for n in (notes or []) if a_s - 0.05 <= n["start"] < b_s]
        lo = min(inside) if inside else 0
        hi = max(inside) if inside else 0
        idx = len(written) + 1
        name = f"{stem_name}_{idx:02d}_{lo}-{hi}.wav"
        audio_io.write_wav24(out_dir / name, seg, sr)
        written.append({
            "src": f"phrases/{name}",
            "start": round(a_s, 3), "end": round(b_s, 3),
            "lo": int(lo), "hi": int(hi),
        })
        if len(written) >= max_phrases:
            break
    return written
