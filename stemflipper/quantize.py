"""Snap transcribed notes to the tempo grid.

basic-pitch / librosa onset times are jittery by ±~50-100 ms, which reads as
"sloppy" in the exported MIDI and in the piano-roll. Snapping note starts to a
subdivided beat grid is the single biggest "feels like a DAW" cleanup. It is a
pure post-process over the plain note dicts ({pitch,start,end,velocity}); it never
touches audio and degrades gracefully to a no-op when the beat grid is unusable.

Design choices (kept conservative so we never corrupt intentionally off-grid parts):
- Snap the NOTE START to the nearest grid line, but only when it is within a
  tolerance of that line (default half a subdivision). A start that sits far from
  every grid line is left alone — that is either a genuine off-grid performance or
  a bad beat estimate, and forcing it would make things worse.
- Preserve each note's DURATION by shifting its end by the same delta as its start,
  then clamp so a note never collapses below a floor and never runs past the song.
- Empty / too-short beat grids -> return the notes unchanged.
"""

from __future__ import annotations

from bisect import bisect_left

import numpy as np

# Minimum surviving note length (s) after snapping — keeps a note audible/selectable.
_MIN_LEN = 0.03


def build_grid(
    beat_times: list[float], subdivision: int, duration: float
) -> list[float]:
    """A sorted list of grid times (seconds): each beat interval split into
    `subdivision` equal steps, extended before the first / after the last detected
    beat by the median beat interval so notes outside the beat span still snap."""
    beats = [float(b) for b in beat_times if np.isfinite(b)]
    if len(beats) < 2 or subdivision < 1:
        return []
    beats.sort()
    diffs = np.diff(beats)
    step_beat = float(np.median(diffs)) if len(diffs) else 0.0
    if step_beat <= 0:
        return []

    grid: list[float] = []
    # subdivide each consecutive beat pair by its own local interval (tempo drift safe)
    for a, b in zip(beats, beats[1:]):
        local = (b - a) / subdivision
        for k in range(subdivision):
            grid.append(a + k * local)
    grid.append(beats[-1])

    # extend backward to 0 and forward to `duration` using the median subdivision step
    step = step_beat / subdivision
    first = grid[0]
    t = first - step
    while t >= -1e-6:
        grid.append(t)
        t -= step
    last = beats[-1]
    end = max(duration, last)
    t = last + step
    while t <= end + 1e-6:
        grid.append(t)
        t += step

    grid = sorted(set(round(g, 6) for g in grid if g >= -1e-6))
    return grid


def _nearest(grid: list[float], t: float) -> float:
    """Nearest grid time to t (grid is sorted)."""
    i = bisect_left(grid, t)
    if i == 0:
        return grid[0]
    if i >= len(grid):
        return grid[-1]
    before, after = grid[i - 1], grid[i]
    return after if (after - t) < (t - before) else before


def _phase_offset(notes: list[dict], grid: list[float], step: float) -> float:
    """Estimate a global phase offset (s) between the notes and the grid.

    librosa's beat tracker lags the true beat by a consistent ~10-30 ms, so a grid
    built straight from `beat_times` sits a bit late and snapping would ADD that lag
    to already-clean notes. We measure the systematic part: the (circular) median of
    each note's signed distance to its nearest grid line, and shift the grid by it.
    Only the SYSTEMATIC offset is removed; random jitter still gets snapped out.
    """
    if step <= 0 or not notes:
        return 0.0
    resid = []
    for n in notes:
        g = _nearest(grid, float(n["start"]))
        d = float(n["start"]) - g  # signed distance to nearest line, in (-step/2, step/2]
        resid.append(d)
    # circular median over one step period (robust to a few off-grid outliers)
    r = np.asarray(resid)
    # wrap to (-step/2, step/2]
    r = (r + step / 2) % step - step / 2
    return float(np.median(r))


def quantize_notes(
    notes: list[dict],
    beat_times: list[float],
    duration: float,
    subdivision: int = 4,
    strength: float = 1.0,
    tolerance_beats: float = 0.5,
) -> list[dict]:
    """Return a new list of notes with starts snapped toward the tempo grid.

    subdivision: grid resolution per beat (4 -> 16th notes, 2 -> 8ths, 1 -> beats).
    strength: 0..1 blend between the original start and the grid line (1 = full snap).
    tolerance_beats: only snap when the start is within this fraction of a subdivision
        of the nearest grid line; farther starts are left untouched.
    """
    if not notes:
        return notes
    grid = build_grid(beat_times, subdivision, duration)
    if len(grid) < 2:
        return notes  # no usable grid -> leave transcription as-is

    # tolerance in seconds = tolerance_beats * one subdivision step (median)
    steps = np.diff(grid)
    step = float(np.median(steps)) if len(steps) else 0.0
    tol = tolerance_beats * step if step > 0 else 0.0
    strength = max(0.0, min(1.0, strength))

    # De-lag the grid: align it to the material so we snap out jitter without adding
    # the beat-tracker's systematic offset to already-tight notes.
    phase = _phase_offset(notes, grid, step)
    if phase:
        grid = [g + phase for g in grid]

    out: list[dict] = []
    for n in notes:
        start = float(n["start"])
        end = float(n["end"])
        g = _nearest(grid, start)
        if tol > 0 and abs(g - start) <= tol:
            new_start = start + (g - start) * strength
        else:
            new_start = start
        delta = new_start - start
        new_end = end + delta  # preserve duration by shifting the whole note
        if new_end - new_start < _MIN_LEN:
            new_end = new_start + max(_MIN_LEN, end - start)
        if duration and new_end > duration:
            new_end = duration
            if new_end - new_start < _MIN_LEN:
                new_start = max(0.0, new_end - _MIN_LEN)
        out.append(
            {
                "pitch": int(n["pitch"]),
                "start": round(max(0.0, new_start), 4),
                "end": round(new_end, 4),
                "velocity": int(n["velocity"]),
            }
        )
    out.sort(key=lambda x: (x["start"], x["pitch"]))
    return out
