"""Bar-aligned loops cut at real downbeats.

A loop that starts a few milliseconds off the bar is unusable, which is why this only
runs when the grid has downbeats. Loops are clustered so the set is varied rather than
eight copies of the same bar, and named with tempo and key so they drop into a library.
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

from .. import audio_io
from . import hits as hits_mod

log = logging.getLogger(__name__)

BAR_LENGTHS = (1, 2, 4)
MAX_LOOPS = 8
_MIN_LOOP_S = 0.5
_MAX_LOOP_S = 20.0
_MIN_ENERGY_RATIO = 0.35   # of this stem's median bar energy
_CLUSTER_DISTANCE = 0.15


def _features(y: np.ndarray, sr: int, a: int, b: int) -> np.ndarray | None:
    import librosa

    seg = np.asarray(y[a:b], dtype=np.float32)
    if len(seg) < int(0.2 * sr):
        return None
    chroma = librosa.feature.chroma_cqt(y=seg, sr=sr).mean(axis=1)
    onset = librosa.onset.onset_strength(y=seg, sr=sr)
    if len(onset) >= 16:
        buckets = np.array_split(onset, 16)
        pattern = np.array([float(b.mean()) for b in buckets])
    else:
        pattern = np.pad(onset.astype(float), (0, max(0, 16 - len(onset))))[:16]
    pattern = pattern / (np.linalg.norm(pattern) or 1.0)
    chroma = chroma / (np.linalg.norm(chroma) or 1.0)
    return np.concatenate([chroma, pattern])


def _cluster(feats: list[np.ndarray], threshold: float = _CLUSTER_DISTANCE) -> list[list[int]]:
    """Greedy cosine clustering — no sklearn dependency for six vectors."""
    clusters: list[list[int]] = []
    centers: list[np.ndarray] = []
    for i, f in enumerate(feats):
        placed = False
        for ci, c in enumerate(centers):
            if 1.0 - float(np.dot(f, c) / ((np.linalg.norm(f) * np.linalg.norm(c)) or 1.0)) < threshold:
                clusters[ci].append(i)
                centers[ci] = (centers[ci] * (len(clusters[ci]) - 1) + f) / len(clusters[ci])
                placed = True
                break
        if not placed:
            clusters.append([i])
            centers.append(f.copy())
    return clusters


def extract_loops(
    stem_name: str,
    y: np.ndarray,
    sr: int,
    grid,
    out_dir: str | Path,
    key: str = "",
    sections: list[dict] | None = None,
    max_loops: int = MAX_LOOPS,
) -> list[dict]:
    """Write loops/<stem>_<n>bar_<bpm>bpm_<key>_<nn>.wav; return their manifest entries."""
    downbeats = list(getattr(grid, "downbeats", []) or [])
    if len(downbeats) < 3:
        beats = list(getattr(grid, "beats", []) or [])
        per_bar = getattr(grid, "beats_per_bar", 4)
        if len(beats) < per_bar * 3:
            return []
        downbeats = beats[::per_bar]
    if len(downbeats) < 3 or y is None or not len(y):
        return []

    out_dir = Path(out_dir)
    tempo = float(getattr(grid, "tempo", 120.0))
    key_tag = (key or "").replace(" ", "").replace("#", "s") or "na"
    section_starts = {round(s["start"], 2) for s in (sections or [])}

    windows: list[tuple[int, float, float, float]] = []  # (bars, start_s, end_s, score)
    for bars in BAR_LENGTHS:
        for i in range(0, len(downbeats) - bars, bars):
            a_s, b_s = downbeats[i], downbeats[i + bars]
            if not (_MIN_LOOP_S <= b_s - a_s <= _MAX_LOOP_S):
                continue
            a, b = int(a_s * sr), min(len(y), int(b_s * sr))
            if b - a < int(_MIN_LOOP_S * sr):
                continue
            seg = y[a:b]
            rms = float(np.sqrt(np.mean(np.square(seg))))
            if rms < 1e-4:
                continue
            windows.append((bars, a_s, b_s, rms))


    if not windows:
        return []

    # Drop windows that are mostly a REST, judged against the rest of this stem rather
    # than by counting quiet samples: percussion is ~65% near-silence between hits, so an
    # absolute quiet-fraction threshold rejected every drum loop in the song.
    median_rms = float(np.median([w[3] for w in windows]))
    kept = []
    for bars, a_s, b_s, rms in windows:
        if rms < _MIN_ENERGY_RATIO * median_rms:
            continue
        bonus = 1.15 if round(a_s, 2) in section_starts else 1.0
        kept.append((bars, a_s, b_s, rms * bonus))
    windows = kept
    if not windows:
        return []

    entries: list[dict] = []
    for bars in BAR_LENGTHS:
        group = [w for w in windows if w[0] == bars]
        if not group:
            continue
        feats, valid = [], []
        for w in group:
            f = _features(y, sr, int(w[1] * sr), int(w[2] * sr))
            if f is not None:
                feats.append(f)
                valid.append(w)
        if not feats:
            continue
        for cluster in _cluster(feats):
            best = max((valid[i] for i in cluster), key=lambda w: w[3])
            entries.append({"bars": bars, "start": best[1], "end": best[2], "score": best[3],
                            "size": len(cluster)})

    entries.sort(key=lambda e: (-e["size"], -e["score"]))
    entries = entries[:max_loops]

    written: list[dict] = []
    for idx, e in enumerate(sorted(entries, key=lambda e: (e["bars"], e["start"]))):
        a, b = int(e["start"] * sr), min(len(y), int(e["end"] * sr))
        seg = hits_mod.fade(np.asarray(y[a:b], dtype=np.float32), sr, 0.005, 0.005)
        name = f"{stem_name}_{e['bars']}bar_{tempo:.0f}bpm_{key_tag}_{idx + 1:02d}.wav"
        audio_io.write_wav24(out_dir / name, seg, sr)
        written.append({
            "src": f"loops/{name}",
            "start": round(e["start"], 3),
            "bars": e["bars"],
            "bpm": round(tempo, 2),
        })
    return written
