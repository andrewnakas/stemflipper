"""End-to-end detection-cleanup verification on *realistically messy* input.

The synthetic audio fixture is clean (deliberate, on-grid notes), so it can't
exercise the artifacts real transcription produces. This test instead starts from
a known-clean note list, corrupts it the way basic-pitch / librosa do (onset
jitter, velocity noise, ghost duplicates, stutter fragments, sub-note blips), then
runs the real cleanup+quantize chain and asserts it recovers something measurably
closer to the truth. This is the end-to-end guard the clean fixture can't provide.
"""

import numpy as np

from stemflipper import cleanup, quantize


TEMPO = 120.0
BEAT = 60.0 / TEMPO           # 0.5 s
STEP = BEAT / 4               # 16th-note grid = 0.125 s


def _clean_melody(n_notes=32):
    """A clean 8th-note melody, every note exactly on the grid, uniform velocity."""
    notes = []
    for i in range(n_notes):
        start = round(i * BEAT / 2, 4)          # 8th notes
        notes.append({"pitch": 60 + (i % 5), "start": start,
                      "end": round(start + BEAT / 2 - 0.02, 4), "velocity": 96})
    return notes


def _beats(n=40):
    # a beat grid that lags the true beat by ~15 ms (like librosa's tracker)
    lag = 0.015
    return [round(lag + i * BEAT, 4) for i in range(n)]


def _corrupt(notes, seed=0):
    """Add the artifacts real transcription emits, deterministically."""
    rng = np.random.default_rng(seed)
    out = []
    for n in notes:
        # onset jitter +-40 ms, velocity jitter +-25
        js = float(rng.uniform(-0.04, 0.04))
        out.append({
            "pitch": n["pitch"],
            "start": round(max(0.0, n["start"] + js), 4),
            "end": round(n["end"] + js, 4),
            "velocity": int(np.clip(n["velocity"] + rng.integers(-25, 25), 1, 127)),
        })
        # ~1 in 4 notes gets a ghost duplicate a few ms later (quieter)
        if rng.random() < 0.25:
            out.append({"pitch": n["pitch"], "start": round(n["start"] + js + 0.008, 4),
                        "end": round(n["end"] + js, 4), "velocity": max(1, out[-1]["velocity"] - 40)})
        # ~1 in 5 notes is split into a stutter fragment (tiny gap, same pitch)
        if rng.random() < 0.2:
            mid = (n["start"] + n["end"]) / 2 + js
            out[-1]["end"] = round(mid, 4)
            out.append({"pitch": n["pitch"], "start": round(mid + 0.02, 4),
                        "end": round(n["end"] + js, 4), "velocity": out[-1]["velocity"]})
        # ~1 in 8 notes spawns a spurious sub-note blip nearby
        if rng.random() < 0.125:
            bt = round(n["start"] + js + 0.06, 4)
            out.append({"pitch": n["pitch"] + 12, "start": bt, "end": round(bt + 0.015, 4),
                        "velocity": 30})
    return out


def _grid_tightness(notes):
    """Fraction of inter-onset gaps that land within 5% of a 16th-note multiple."""
    starts = sorted(n["start"] for n in notes)
    if len(starts) < 2:
        return 0.0
    gaps = np.diff(starts) / STEP
    return float(np.mean(np.abs(gaps - np.round(gaps)) < 0.05))


def _onset_jitter(notes):
    """Mean abs residual of onsets to the nearest 16th line, phase-removed (ms)."""
    r = np.array([n["start"] % STEP for n in notes])
    r = (r + STEP / 2) % STEP - STEP / 2
    r = r - np.median(r)
    return float(np.mean(np.abs(r)) * 1000)


def test_cleanup_quantize_recovers_clean_melody():
    truth = _clean_melody()
    messy = _corrupt(truth, seed=1)
    beats = _beats()

    # the corruption really did make a mess
    assert len(messy) > len(truth)                    # ghosts/stutter/blips added notes
    assert _grid_tightness(messy) < 0.6

    cleaned = cleanup.clean_notes(messy, is_drum=False)
    result = quantize.quantize_notes(cleaned, beats, duration=truth[-1]["end"] + 1)

    # 1) artifact count drops back toward the truth count
    assert len(result) <= len(messy)
    assert len(result) < len(messy) - 3               # removed several ghosts/blips/stutter

    # 2) the blips (pitch 72+, 15 ms) are gone
    assert not any(n["pitch"] >= 72 and (n["end"] - n["start"]) < 0.035 for n in result)

    # 3) timing is tighter: more onsets land on the 16th grid, less jitter
    assert _grid_tightness(result) > _grid_tightness(messy)
    assert _onset_jitter(result) < _onset_jitter(messy)


def test_cleanup_quantize_is_idempotent_on_clean_input():
    """Running the chain on already-clean, on-grid notes barely changes them."""
    truth = _clean_melody()
    beats = [round(i * BEAT, 4) for i in range(40)]    # perfectly phased grid
    cleaned = cleanup.clean_notes(truth, is_drum=False)
    result = quantize.quantize_notes(cleaned, beats, duration=truth[-1]["end"] + 1)
    assert len(result) == len(truth)                   # nothing removed
    # onsets essentially unchanged (within a hair of the grid they already sit on)
    for a, b in zip(sorted(result, key=lambda n: n["start"]), truth):
        assert abs(a["start"] - b["start"]) < 0.01


def test_recovery_is_robust_across_seeds():
    """The cleanup+quantize chain recovers the true note count across many corruption
    patterns — a guard that the thresholds generalize, not overfit one seed. If a future
    threshold change starts leaving artifacts or eating real notes, this catches it."""
    truth = _clean_melody()
    beats = _beats()
    dur = truth[-1]["end"] + 1
    for seed in range(12):
        messy = _corrupt(truth, seed=seed)
        result = quantize.quantize_notes(
            cleanup.clean_notes(messy, is_drum=False), beats, duration=dur
        )
        # exact recovery of the true note count on every seed
        assert len(result) == len(truth), f"seed {seed}: {len(result)} != {len(truth)}"
        # and no residual same-pitch onsets closer than an 8th note (un-merged ghosts)
        by_pitch = {}
        for n in sorted(result, key=lambda x: (x["pitch"], x["start"])):
            by_pitch.setdefault(n["pitch"], []).append(n["start"])
        for starts in by_pitch.values():
            for a, b in zip(starts, starts[1:]):
                assert b - a >= BEAT / 2 - 1e-6, f"seed {seed}: onsets {a},{b} too close"


def test_messy_corruption_is_deterministic():
    a = _corrupt(_clean_melody(), seed=7)
    b = _corrupt(_clean_melody(), seed=7)
    assert a == b
