"""Post-transcription note cleanup: dedup, merge stutter, smooth velocity.

basic-pitch (and the drum heuristic) emit three recurring artifacts that read as
"sloppy" in the MIDI/piano-roll:
  1. near-duplicate onsets — the same pitch fired twice within a few ms (a ghost).
  2. stutter — a held note broken into a rapid run of same-pitch notes with tiny gaps.
  3. velocity jitter — successive notes of one pitch jumping 40-50 units frame-to-frame.

These are pure post-processes over the plain note dicts ({pitch,start,end,velocity}).
They run BEFORE quantization (clean the set, then snap). Every step is conservative
and fail-safe: it only removes/merges clear artifacts and leaves musical detail alone.
"""

from __future__ import annotations

import numpy as np

# Two same-pitch onsets closer than this are treated as one hit (a ghost/double-trigger).
_DEDUP_S = 0.045
# A same-pitch gap shorter than this between a note's end and the next's start is a
# stutter of one held note -> merge them.
_MERGE_GAP_S = 0.06
# Notes shorter than this (after merging) are spurious "blips" — below the length of a
# real played note (basic-pitch's own minimum_note_length default is ~58 ms). Dropped.
_MIN_LEN_S = 0.035


def dedup_notes(notes: list[dict], tol_s: float = _DEDUP_S) -> list[dict]:
    """Collapse same-pitch notes whose onsets are within tol_s. Keeps the louder
    velocity and the later end (so the surviving note covers both)."""
    if not notes:
        return notes
    ordered = sorted(notes, key=lambda n: (n["pitch"], n["start"]))
    out: list[dict] = []
    for n in ordered:
        if (
            out
            and out[-1]["pitch"] == n["pitch"]
            and abs(n["start"] - out[-1]["start"]) <= tol_s
        ):
            prev = out[-1]
            prev["velocity"] = max(prev["velocity"], n["velocity"])
            prev["end"] = max(prev["end"], n["end"])
        else:
            out.append(dict(n))
    return out


def merge_stutter(notes: list[dict], gap_s: float = _MERGE_GAP_S) -> list[dict]:
    """Join consecutive same-pitch notes separated by a gap shorter than gap_s into
    one sustained note (kills a held note that got chopped into a rapid run)."""
    if not notes:
        return notes
    ordered = sorted(notes, key=lambda n: (n["pitch"], n["start"]))
    out: list[dict] = []
    for n in ordered:
        if (
            out
            and out[-1]["pitch"] == n["pitch"]
            and n["start"] - out[-1]["end"] <= gap_s
            and n["start"] >= out[-1]["start"]
        ):
            prev = out[-1]
            prev["end"] = max(prev["end"], n["end"])
            prev["velocity"] = max(prev["velocity"], n["velocity"])
        else:
            out.append(dict(n))
    return out


def smooth_velocity(notes: list[dict], kernel: int = 3) -> list[dict]:
    """Median-smooth velocities across consecutive same-pitch notes to tame frame-level
    jitter. Runs of the same pitch (in time order) get a rolling median; isolated notes
    are untouched. kernel is the (odd) window size."""
    if not notes or kernel < 3:
        return notes
    ordered = sorted(notes, key=lambda n: (n["pitch"], n["start"]))
    half = kernel // 2
    # group by pitch, preserving time order within each group
    groups: dict[int, list[dict]] = {}
    for n in ordered:
        groups.setdefault(n["pitch"], []).append(n)
    for grp in groups.values():
        if len(grp) < kernel:
            continue
        vels = [g["velocity"] for g in grp]
        for i in range(len(grp)):
            lo, hi = max(0, i - half), min(len(grp), i + half + 1)
            grp[i]["velocity"] = int(np.median(vels[lo:hi]))
    return ordered


def drop_blips(notes: list[dict], min_len_s: float = _MIN_LEN_S) -> list[dict]:
    """Drop notes shorter than min_len_s — spurious sub-note blips basic-pitch emits.
    Runs AFTER merge so a stutter-fragment that got joined into a real note survives;
    only genuinely isolated ultra-short notes are removed. Drums are exempt (percussive
    hits are legitimately short); the caller passes only pitched stems, or gates on it."""
    if not notes:
        return notes
    return [n for n in notes if (n["end"] - n["start"]) >= min_len_s]


def clean_notes(
    notes: list[dict],
    *,
    dedup: bool = True,
    merge: bool = True,
    smooth: bool = True,
    drop_short: bool = True,
    is_drum: bool = False,
) -> list[dict]:
    """Run the cleanup chain (dedup -> merge stutter -> drop blips -> smooth velocity)
    and return a time-sorted list. Any step can be disabled. Blip-dropping is skipped for
    drums (percussive hits are legitimately short). Fail-safe: empty in -> empty out."""
    if not notes:
        return notes
    out = [dict(n) for n in notes]
    if dedup:
        out = dedup_notes(out)
    if merge:
        out = merge_stutter(out)
    if drop_short and not is_drum:
        out = drop_blips(out)
    if smooth:
        out = smooth_velocity(out)
    out.sort(key=lambda n: (n["start"], n["pitch"]))
    return out
