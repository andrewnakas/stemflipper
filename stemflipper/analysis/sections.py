"""Song sections (intro / verse / chorus-like blocks) via self-similarity novelty.

Best-effort and unlabelled beyond A/B/C: sections drive loop selection (prefer a loop at
a section start) and arrangement markers in the exported MIDI. Returns [] rather than
guessing when the song is too short or the novelty curve is flat.
"""

from __future__ import annotations

import numpy as np

_MIN_SECTION_S = 8.0


def estimate_sections(
    y: np.ndarray, sr: int, downbeats: list[float], duration: float, max_sections: int = 8
) -> list[dict]:
    downbeats = [float(b) for b in (downbeats or [])]
    if duration < 30.0 or len(downbeats) < 6:
        return []
    try:
        import librosa

        mono = np.asarray(y.mean(axis=1) if y.ndim > 1 else y, dtype=np.float32)
        chroma = librosa.feature.chroma_cqt(y=mono, sr=sr)
        mfcc = librosa.feature.mfcc(y=mono, sr=sr, n_mfcc=13)
        frames = np.clip(librosa.time_to_frames(np.array(downbeats), sr=sr), 0, chroma.shape[1] - 1)

        feats = []
        for a, b in zip(frames[:-1], frames[1:]):
            hi = max(a + 1, b)
            feats.append(np.concatenate([chroma[:, a:hi].mean(axis=1), mfcc[:, a:hi].mean(axis=1)]))
        feats = np.array(feats)
        feats = (feats - feats.mean(axis=0)) / (feats.std(axis=0) + 1e-8)

        # novelty = distance between consecutive bar-feature windows
        novelty = np.linalg.norm(np.diff(feats, axis=0), axis=1)
        if not len(novelty) or float(np.std(novelty)) < 1e-6:
            return []
        threshold = float(np.mean(novelty) + np.std(novelty))
        cuts = [0]
        for i, v in enumerate(novelty):
            t = downbeats[i + 1]
            if v > threshold and t - downbeats[cuts[-1]] >= _MIN_SECTION_S:
                cuts.append(i + 1)
        if len(cuts) < 2:
            return []
        cuts = cuts[:max_sections]

        bounds = [downbeats[c] for c in cuts] + [duration]
        return [
            {"start": round(a, 3), "end": round(b, 3), "label": chr(ord("A") + i)}
            for i, (a, b) in enumerate(zip(bounds[:-1], bounds[1:]))
            if b - a >= _MIN_SECTION_S
        ]
    except Exception:
        return []
