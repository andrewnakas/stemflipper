"""Monophonic pitch tracking -> notes, for bass and lead vocal lines.

basic-pitch is a polyphonic model; on a single-voice stem it tends to emit octave ghosts
and fragments a held note into pieces. Tracking a continuous f0 and segmenting it into
notes is both more accurate and gives us pitch data the sampler and synth stages want
(true root frequency per note, vibrato, glide).

Backend is pluggable. Today: librosa's pyin (BSD, no download, solid on an isolated
stem). The intended upgrade is RMVPE (MIT weights, far better on breathy/expressive
vocals) — `f0_to_notes` is deliberately backend-agnostic so it can slot in.
"""

from __future__ import annotations

import logging

import numpy as np

log = logging.getLogger(__name__)

HOP_S = 0.01

#: search ranges per stem (Hz)
RANGES = {
    "bass": (30.0, 400.0),
    "vocals": (65.0, 1200.0),
    "guitar": (70.0, 1400.0),
    "other": (55.0, 2000.0),
}

_MIN_NOTE_S = 0.06
_CENTS_TOL = 60.0     # pitch move that starts a new note
_GAP_FRAMES = 3       # unvoiced frames that end a note
_SMOOTH_FRAMES = 5    # ~50 ms median filter: removes tracker jitter, not vibrato
_LOOKAHEAD_FRAMES = 22     # ~220 ms: longer than one 5 Hz vibrato period
_MIN_STEP_FRAMES = 6       # both comparison windows need this much voiced pitch
_SILENCE_FRACTION = 0.06   # of the phrase's 75th-percentile level = a rest, not a note


def pyin_f0(y: np.ndarray, sr: int, stem_name: str = "other") -> dict | None:
    """{'f0': Hz per frame (nan when unvoiced), 'conf': 0..1, 'hop_s': float} or None."""
    import librosa

    fmin, fmax = RANGES.get(stem_name, RANGES["other"])
    y = np.asarray(y, dtype=np.float32)
    if not len(y) or float(np.abs(y).max()) < 1e-4:
        return None
    hop = max(1, int(HOP_S * sr))
    try:
        f0, voiced, voiced_prob = librosa.pyin(
            y, fmin=fmin, fmax=fmax, sr=sr, hop_length=hop, fill_na=np.nan
        )
    except Exception as e:
        log.warning("pyin failed on %s: %s", stem_name, e)
        return None
    return {
        "f0": f0,
        "conf": np.nan_to_num(voiced_prob, nan=0.0),
        "voiced": np.nan_to_num(voiced, nan=False).astype(bool),
        "hop_s": hop / sr,
    }


def hz_to_midi(f0: np.ndarray) -> np.ndarray:
    with np.errstate(divide="ignore", invalid="ignore"):
        return 69.0 + 12.0 * np.log2(np.asarray(f0, dtype=float) / 440.0)


def f0_to_notes(
    track: dict,
    y: np.ndarray | None = None,
    sr: int | None = None,
    min_len_s: float = _MIN_NOTE_S,
    cents_tol: float = _CENTS_TOL,
) -> list[dict]:
    """Segment a continuous f0 track into notes.

    A note ends when the voice drops out for a few frames or the pitch moves further than
    `cents_tol` from the note's running median — which keeps vibrato and small slides
    inside one note instead of shattering them.
    """
    if not track:
        return []
    f0 = np.asarray(track["f0"], dtype=float)
    conf = np.asarray(track.get("conf", np.ones_like(f0)), dtype=float)
    hop_s = float(track.get("hop_s", HOP_S))
    if not len(f0):
        return []

    midi = hz_to_midi(f0)
    voiced = np.isfinite(midi)
    # Median-filter the pitch contour before segmenting. Singers vibrato +-50-100 cents at
    # ~5 Hz; comparing raw frames against a tolerance shatters a held note into a dozen
    # alternating semitones (measured: a 60-cent vibrato became 12 notes). A ~70 ms median
    # window flattens vibrato and tracker jitter while leaving a real note change — which
    # is both larger and sustained — completely intact.
    if voiced.sum() >= _SMOOTH_FRAMES:
        smoothed = midi.copy()
        idx = np.flatnonzero(voiced)
        vals = midi[idx]
        half = _SMOOTH_FRAMES // 2
        padded = np.pad(vals, (half, half), mode="edge")
        smoothed[idx] = np.array([
            np.median(padded[i : i + _SMOOTH_FRAMES]) for i in range(len(vals))
        ])
        midi = smoothed

    # amplitude envelope for velocity, aligned to the f0 hop
    env = None
    if y is not None and sr:
        hop = max(1, int(round(hop_s * sr)))
        frames = int(np.ceil(len(y) / hop))
        pad = np.pad(np.asarray(y, dtype=float), (0, max(0, frames * hop - len(y))))
        env = np.sqrt(np.mean(pad.reshape(frames, hop) ** 2, axis=1))
        peak = float(env.max()) or 1.0
        env = env / peak

    # Amplitude also marks note boundaries. pyin's analysis window is several periods
    # long (~60 ms at the bottom of a vocal range), so a short REST between two notes of
    # the same pitch can pass with barely an unvoiced frame — two notes become one held
    # note. A drop to a small fraction of the phrase's level is unambiguous, so treat it
    # as a gap too.
    if env is not None and len(env) >= len(voiced):
        loud = float(np.percentile(env[: len(voiced)][voiced], 75)) if voiced.any() else 0.0
        if loud > 0:
            quiet = env[: len(voiced)] < _SILENCE_FRACTION * loud
            voiced = voiced & ~quiet

    notes: list[dict] = []
    start = None
    pitches: list[float] = []
    confs: list[float] = []
    gap = 0

    def close(end_frame: int) -> None:
        nonlocal start, pitches, confs
        if start is None or not pitches:
            start, pitches, confs = None, [], []
            return
        dur = (end_frame - start) * hop_s
        if dur >= min_len_s:
            pitch = int(np.clip(round(float(np.median(pitches))), 0, 127))
            if env is not None:
                seg = env[start : max(start + 1, end_frame)]
                velocity = int(np.clip(30 + 97 * float(seg.max()), 1, 127))
            else:
                velocity = 90
            stability = 1.0 - min(1.0, float(np.std(pitches)) / 1.0)
            notes.append({
                "pitch": pitch,
                "start": round(start * hop_s, 4),
                "end": round(end_frame * hop_s, 4),
                "velocity": velocity,
                "confidence": round(float(np.clip(np.mean(confs) * 0.5 + stability * 0.5, 0.05, 1.0)), 3),
            })
        start, pitches, confs = None, [], []

    for i, (m, ok) in enumerate(zip(midi, voiced)):
        if not ok:
            gap += 1
            if start is not None and gap >= _GAP_FRAMES:
                close(i - gap + 1)
            continue
        gap = 0
        if start is None:
            start, pitches, confs = i, [m], [conf[i] if i < len(conf) else 1.0]
            continue
        if abs(m - float(np.median(pitches))) * 100.0 > cents_tol:
            # Out of tolerance — a NEW NOTE, or the far swing of a vibrato?
            # Compare the median pitch just BEFORE this frame with the median just AFTER
            # it. A note change is a step: the two windows sit at different pitches. A
            # vibrato oscillates about a stable centre, so both windows share it — and
            # because the comparison is symmetric it cannot be thrown off by where the
            # current note happened to start (an unstable attack used to seed a bad split
            # that then cascaded through the whole note).
            back = midi[max(0, i - _LOOKAHEAD_FRAMES) : i]
            fwd = midi[i : i + _LOOKAHEAD_FRAMES]
            back = back[np.isfinite(back)]
            fwd = fwd[np.isfinite(fwd)]
            stepped = (
                len(back) >= _MIN_STEP_FRAMES
                and len(fwd) >= _MIN_STEP_FRAMES
                and abs(float(np.median(fwd)) - float(np.median(back))) * 100.0 > cents_tol
            )
            if stepped:
                close(i)
                start, pitches, confs = i, [m], [conf[i] if i < len(conf) else 1.0]
            else:
                pitches.append(m)
                confs.append(conf[i] if i < len(conf) else 1.0)
        else:
            pitches.append(m)
            confs.append(conf[i] if i < len(conf) else 1.0)

    if start is not None:
        close(len(midi) - gap)
    return _merge_fragments(notes)


def _merge_fragments(notes: list[dict], max_gap_s: float = 0.03) -> list[dict]:
    """Absorb short attack/tail fragments into the note they belong to.

    Pitch tracking is least stable at a note's very start and at the end of its decay, so
    a sung note often comes out as a 90 ms fragment, the note itself, then another
    fragment — all within a semitone. Merging them back is safe because it only applies
    to neighbours that are adjacent (a real repeated note has an audible gap) and within
    a semitone (a real interval is larger).
    """
    if len(notes) < 2:
        return notes
    out = [dict(notes[0])]
    for n in notes[1:]:
        prev = out[-1]
        gap = n["start"] - prev["end"]
        close_in_pitch = abs(n["pitch"] - prev["pitch"]) <= 1
        prev_len = prev["end"] - prev["start"]
        this_len = n["end"] - n["start"]
        fragment = min(prev_len, this_len) < 0.15 and max(prev_len, this_len) > 2 * min(prev_len, this_len)
        if close_in_pitch and gap <= max_gap_s and fragment:
            keep = prev if prev_len >= this_len else n
            prev["pitch"] = keep["pitch"]
            prev["end"] = max(prev["end"], n["end"])
            prev["velocity"] = max(prev["velocity"], n["velocity"])
            prev["confidence"] = max(prev["confidence"], n["confidence"])
        else:
            out.append(dict(n))
    return out


def transcribe_mono(y: np.ndarray, sr: int, stem_name: str = "other") -> list[dict]:
    """Convenience: f0 track -> notes for one monophonic stem."""
    track = pyin_f0(y, sr, stem_name)
    if track is None:
        return []
    return f0_to_notes(track, y=y, sr=sr)
