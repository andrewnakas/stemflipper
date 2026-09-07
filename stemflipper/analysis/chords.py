"""Per-beat chord estimation — numpy/librosa only, no model download.

A chord track is what makes an exported project usable as a starting point: it labels the
harmony in the browser, exports as a MIDI chord track, and tells the loop namer what key a
loop is in. Template matching over beat-synchronous chroma with Viterbi smoothing is the
classic, dependency-free approach: not state of the art, but honest and stable.
"""

from __future__ import annotations

import numpy as np

PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# (suffix, semitone offsets) — deliberately a small, reliable vocabulary.
QUALITIES: list[tuple[str, str, tuple[int, ...]]] = [
    ("", "maj", (0, 4, 7)),
    ("m", "min", (0, 3, 7)),
    ("7", "dom7", (0, 4, 7, 10)),
    ("m7", "min7", (0, 3, 7, 10)),
    ("maj7", "maj7", (0, 4, 7, 11)),
    ("5", "power", (0, 7)),
]
_NO_CHORD = "N"


def _templates() -> tuple[np.ndarray, list[tuple[str, int, str]]]:
    rows, labels = [], []
    for root in range(12):
        for suffix, quality, offsets in QUALITIES:
            vec = np.zeros(12, dtype=float)
            for off in offsets:
                vec[(root + off) % 12] = 1.0
            rows.append(vec / np.linalg.norm(vec))
            labels.append((f"{PITCH_NAMES[root]}{suffix}", root, quality))
    return np.array(rows), labels


_TEMPLATES, _LABELS = _templates()


def _beat_chroma(y: np.ndarray, sr: int, beats: list[float]) -> np.ndarray:
    import librosa

    mono = y.mean(axis=1) if y.ndim > 1 else y
    mono = np.asarray(mono, dtype=np.float32)
    chroma = librosa.feature.chroma_cqt(y=mono, sr=sr)
    frames = librosa.time_to_frames(np.asarray(beats, dtype=float), sr=sr)
    frames = np.clip(frames, 0, chroma.shape[1] - 1)
    out = []
    for a, b in zip(frames[:-1], frames[1:]):
        seg = chroma[:, a : max(a + 1, b)]
        out.append(seg.mean(axis=1) if seg.size else np.zeros(12))
    return np.array(out)


def _viterbi(scores: np.ndarray, self_transition: float = 0.35) -> list[int]:
    """Cheap smoothing: reward staying on the same chord across beats."""
    n_obs, n_states = scores.shape
    if n_obs == 0:
        return []
    bonus = np.full((n_states, n_states), 0.0)
    np.fill_diagonal(bonus, self_transition)
    best = scores[0].copy()
    back = np.zeros((n_obs, n_states), dtype=int)
    for t in range(1, n_obs):
        total = best[:, None] + bonus
        prev = np.argmax(total, axis=0)
        best = total[prev, np.arange(n_states)] + scores[t]
        back[t] = prev
    path = [int(np.argmax(best))]
    for t in range(n_obs - 1, 0, -1):
        path.append(int(back[t][path[-1]]))
    return path[::-1]


def estimate_chords(
    y: np.ndarray, sr: int, beats: list[float], min_conf: float = 0.55
) -> list[dict]:
    """One entry per run of equal beat-chords: {start, end, label, root, quality, conf}."""
    beats = [float(b) for b in (beats or [])]
    if len(beats) < 3:
        return []
    chroma = _beat_chroma(y, sr, beats)
    if not len(chroma):
        return []

    norms = np.linalg.norm(chroma, axis=1, keepdims=True)
    energy = norms.ravel()
    unit = chroma / np.clip(norms, 1e-8, None)
    scores = unit @ _TEMPLATES.T                       # cosine similarity per template
    path = _viterbi(scores)

    # Silent / atonal beats become "no chord" rather than a confident wrong guess.
    quiet = energy < max(1e-6, 0.15 * float(np.median(energy)))

    out: list[dict] = []
    for i, state in enumerate(path):
        label, root, quality = _LABELS[state]
        conf = float(scores[i, state])
        if quiet[i] or conf < min_conf:
            label, root, quality, conf = _NO_CHORD, None, None, conf
        start, end = beats[i], beats[i + 1]
        if out and out[-1]["label"] == label:
            out[-1]["end"] = round(end, 4)
            out[-1]["conf"] = round(max(out[-1]["conf"], conf), 3)
        else:
            out.append({
                "start": round(start, 4), "end": round(end, 4), "label": label,
                "root": root, "quality": quality, "conf": round(conf, 3),
            })
    return [c for c in out if c["label"] != _NO_CHORD]
