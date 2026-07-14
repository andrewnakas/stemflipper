"""Unit tests for the tempo-grid note quantizer (pure, no audio)."""

import numpy as np

from stemflipper import quantize


def _beats(bpm=120.0, n=16, start=0.0):
    """A clean beat grid at a fixed tempo."""
    step = 60.0 / bpm
    return [round(start + i * step, 6) for i in range(n)]


def test_snaps_jittered_notes_and_reduces_onset_error():
    # 120 BPM -> beats every 0.5s; 16th grid every 0.125s. Place notes ON 8th-note
    # grid lines, then jitter them by up to ~40 ms and confirm snapping pulls them back.
    beats = _beats(bpm=120.0, n=16)
    duration = beats[-1] + 0.5
    rng = np.random.default_rng(0)
    ideal = [i * 0.25 for i in range(12)]  # exact 8th-note onsets
    jittered = [
        {"pitch": 60, "start": round(t + float(rng.uniform(-0.04, 0.04)), 4),
         "end": round(t + 0.2, 4), "velocity": 100}
        for t in ideal
    ]
    out = quantize.quantize_notes(jittered, beats, duration, subdivision=4)

    # aggregate onset error vs the ideal grid must drop after snapping (the notes end
    # up tighter to their true 8th-note positions; the grid is phase-aligned to 0 here)
    err_before = sum(abs(j["start"] - t) for j, t in zip(jittered, ideal))
    err_after = sum(abs(o["start"] - t) for o, t in zip(out, ideal))
    assert err_after < err_before, f"{err_after} !< {err_before}"

    # and the inter-onset spacing should collapse onto near-exact 16th-note multiples
    starts = sorted(o["start"] for o in out)
    gaps = np.diff(starts) / 0.125
    on_grid = np.mean(np.abs(gaps - np.round(gaps)) < 0.05)
    raw_gaps = np.diff(sorted(j["start"] for j in jittered)) / 0.125
    raw_on_grid = np.mean(np.abs(raw_gaps - np.round(raw_gaps)) < 0.05)
    assert on_grid > raw_on_grid, f"grid tightness not improved ({on_grid} vs {raw_on_grid})"


def test_preserves_note_duration():
    # A cluster of clean on-grid notes plus one whose duration we track. Duration must
    # survive the snap (start and end shift together).
    beats = _beats(bpm=120.0, n=16)
    notes = [
        {"pitch": 48, "start": 0.51, "end": 0.71, "velocity": 90},   # len 0.20, tracked
        {"pitch": 48, "start": 1.01, "end": 1.20, "velocity": 90},
        {"pitch": 48, "start": 1.49, "end": 1.70, "velocity": 90},
    ]
    out = quantize.quantize_notes(notes, beats, duration=8.0, subdivision=4)
    tracked = min(out, key=lambda n: abs(n["start"] - 0.5))
    length = tracked["end"] - tracked["start"]
    assert abs(length - 0.20) < 1e-3, f"duration changed: {length}"
    # 0.51 snaps toward the ~0.5 grid line (within a subdivision)
    assert abs(tracked["start"] - 0.5) < 0.02


def test_leaves_far_offgrid_notes_alone():
    # Anchor the grid phase to 0 with on-grid notes, then one note that lands exactly
    # between two 16th lines (0.0625s from each). With a tolerance below that gap it
    # must be left alone rather than yanked to a line.
    beats = _beats(bpm=120.0, n=16)
    off = 0.3125  # exactly between 0.25 and 0.375 grid lines -> 0.0625 from each
    notes = [
        {"pitch": 60, "start": 0.0, "end": 0.1, "velocity": 80},
        {"pitch": 60, "start": 0.25, "end": 0.35, "velocity": 80},
        {"pitch": 60, "start": 0.5, "end": 0.6, "velocity": 80},
        {"pitch": 62, "start": off, "end": off + 0.1, "velocity": 80},  # off-grid target
    ]
    out = quantize.quantize_notes(notes, beats, duration=8.0, subdivision=4,
                                  tolerance_beats=0.4)  # tol = 0.4*0.125 = 0.05 < 0.0625
    target = next(n for n in out if n["pitch"] == 62)
    assert abs(target["start"] - off) < 1e-3, "off-grid note should be untouched"


def test_empty_grid_is_noop():
    notes = [{"pitch": 60, "start": 0.37, "end": 0.5, "velocity": 100}]
    assert quantize.quantize_notes(notes, [], 8.0) == notes
    assert quantize.quantize_notes(notes, [1.0], 8.0) == notes  # <2 beats


def test_empty_notes_is_noop():
    assert quantize.quantize_notes([], _beats(), 8.0) == []


def test_no_note_collapses_or_exceeds_duration():
    beats = _beats(bpm=120.0, n=8)
    duration = 4.0
    notes = [
        {"pitch": 40, "start": 3.98, "end": 3.99, "velocity": 100},  # near the end
        {"pitch": 41, "start": 0.02, "end": 0.05, "velocity": 100},  # very short
    ]
    out = quantize.quantize_notes(notes, beats, duration, subdivision=4)
    for n in out:
        assert n["end"] > n["start"], "note collapsed"
        assert n["end"] - n["start"] >= 0.029, "note below min length"
        assert n["end"] <= duration + 1e-6, "note past song end"
        assert n["start"] >= 0.0


def test_strength_partial_snap():
    beats = _beats(bpm=120.0, n=16)
    # Anchor the grid phase to 0 with several clean on-grid notes, then one target note
    # sitting 40 ms past its 0.5 grid line. Half-strength should move it ~halfway back.
    notes = [
        {"pitch": 60, "start": 0.0, "end": 0.1, "velocity": 100},
        {"pitch": 60, "start": 0.25, "end": 0.35, "velocity": 100},
        {"pitch": 60, "start": 1.0, "end": 1.1, "velocity": 100},
        {"pitch": 62, "start": 0.54, "end": 0.70, "velocity": 100},  # target: +40ms
    ]
    out = quantize.quantize_notes(notes, beats, 8.0, subdivision=4, strength=0.5)
    target = next(n for n in out if n["pitch"] == 62)
    # from 0.54 halfway toward 0.5 => ~0.52
    assert 0.515 < target["start"] < 0.525, target["start"]


def test_corrects_systematic_grid_lag():
    # Real beat trackers lag the true beat by a constant offset. Simulate: notes sit
    # exactly on an 8th grid anchored at 0, but beat_times are shifted +20 ms late.
    # Quantization must de-lag (snap notes back onto their own grid, NOT add the lag).
    lag = 0.020
    beats = [round(b + lag, 6) for b in _beats(bpm=120.0, n=16)]
    ideal = [i * 0.25 for i in range(12)]  # clean 8th-note onsets at 0, .25, .5 ...
    notes = [{"pitch": 60, "start": t, "end": t + 0.2, "velocity": 100} for t in ideal]
    out = quantize.quantize_notes(notes, beats, duration=8.0, subdivision=4)
    # after de-lagging, starts should stay ~on the original clean grid, not drift +20ms
    for o, t in zip(out, ideal):
        assert abs(o["start"] - t) < 0.006, f"{o['start']} drifted from {t}"


def test_build_grid_covers_song():
    beats = _beats(bpm=120.0, n=8, start=1.0)  # beats start at 1.0s
    grid = quantize.build_grid(beats, subdivision=4, duration=10.0)
    assert grid[0] <= 0.02, "grid should extend back toward 0"
    assert grid[-1] >= 9.9, "grid should extend to near duration"
    # spacing is a 16th at 120 BPM = 0.125s
    d = np.diff(grid)
    assert abs(float(np.median(d)) - 0.125) < 1e-3
