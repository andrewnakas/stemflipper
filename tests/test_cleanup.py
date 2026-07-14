"""Unit tests for the post-transcription note cleanup (pure, no audio)."""

from stemflipper import cleanup


def test_dedup_collapses_ghost_onsets():
    # same pitch fired twice ~2 ms apart -> one note, louder velocity, later end
    notes = [
        {"pitch": 60, "start": 0.500, "end": 0.60, "velocity": 100},
        {"pitch": 60, "start": 0.502, "end": 0.65, "velocity": 50},
    ]
    out = cleanup.dedup_notes(notes)
    assert len(out) == 1
    assert out[0]["velocity"] == 100          # kept the louder
    assert abs(out[0]["end"] - 0.65) < 1e-9   # kept the later end


def test_dedup_keeps_distinct_onsets():
    notes = [
        {"pitch": 60, "start": 0.0, "end": 0.1, "velocity": 100},
        {"pitch": 60, "start": 0.5, "end": 0.6, "velocity": 100},  # well separated
    ]
    assert len(cleanup.dedup_notes(notes)) == 2


def test_dedup_keeps_different_pitches():
    notes = [
        {"pitch": 60, "start": 0.50, "end": 0.6, "velocity": 100},
        {"pitch": 64, "start": 0.50, "end": 0.6, "velocity": 100},  # chord, same time
    ]
    assert len(cleanup.dedup_notes(notes)) == 2


def test_merge_stutter_joins_held_note():
    # a held note chopped into three same-pitch pieces with ~20 ms gaps -> one note
    notes = [
        {"pitch": 55, "start": 0.00, "end": 0.20, "velocity": 90},
        {"pitch": 55, "start": 0.22, "end": 0.42, "velocity": 80},
        {"pitch": 55, "start": 0.44, "end": 0.64, "velocity": 85},
    ]
    out = cleanup.merge_stutter(notes)
    assert len(out) == 1
    assert abs(out[0]["start"] - 0.0) < 1e-9
    assert abs(out[0]["end"] - 0.64) < 1e-9
    assert out[0]["velocity"] == 90


def test_merge_stutter_respects_real_rests():
    # a clear rest (200 ms gap) between two notes must NOT be merged
    notes = [
        {"pitch": 55, "start": 0.0, "end": 0.2, "velocity": 90},
        {"pitch": 55, "start": 0.4, "end": 0.6, "velocity": 90},
    ]
    assert len(cleanup.merge_stutter(notes)) == 2


def test_smooth_velocity_medians_a_spike():
    # a run of one pitch with a single spiked velocity -> median smooths the spike
    notes = [
        {"pitch": 62, "start": 0.0, "end": 0.1, "velocity": 80},
        {"pitch": 62, "start": 0.2, "end": 0.3, "velocity": 120},  # spike
        {"pitch": 62, "start": 0.4, "end": 0.5, "velocity": 82},
        {"pitch": 62, "start": 0.6, "end": 0.7, "velocity": 79},
    ]
    out = cleanup.smooth_velocity(notes, kernel=3)
    spike = next(n for n in out if abs(n["start"] - 0.2) < 1e-9)
    assert spike["velocity"] < 120  # pulled down toward its neighbors
    assert 79 <= spike["velocity"] <= 82


def test_smooth_velocity_leaves_short_runs():
    notes = [
        {"pitch": 62, "start": 0.0, "end": 0.1, "velocity": 80},
        {"pitch": 62, "start": 0.2, "end": 0.3, "velocity": 120},  # only 2 -> untouched
    ]
    out = cleanup.smooth_velocity(notes, kernel=3)
    assert {n["velocity"] for n in out} == {80, 120}


def test_clean_notes_chain_is_fail_safe():
    assert cleanup.clean_notes([]) == []
    one = [{"pitch": 60, "start": 0.0, "end": 0.5, "velocity": 100}]
    assert cleanup.clean_notes(one) == one


def test_clean_notes_reduces_artifact_count():
    # a ghost + a stutter run + a clean note -> fewer notes out than in
    notes = [
        {"pitch": 60, "start": 0.500, "end": 0.60, "velocity": 100},
        {"pitch": 60, "start": 0.503, "end": 0.61, "velocity": 40},   # ghost of above
        {"pitch": 48, "start": 1.00, "end": 1.20, "velocity": 90},
        {"pitch": 48, "start": 1.22, "end": 1.42, "velocity": 88},    # stutter
        {"pitch": 48, "start": 1.44, "end": 1.64, "velocity": 91},    # stutter
        {"pitch": 72, "start": 2.00, "end": 2.30, "velocity": 100},   # clean, isolated
    ]
    out = cleanup.clean_notes(notes)
    assert len(out) < len(notes)
    assert len(out) == 3  # one 60, one merged 48, one 72
    # output stays time-sorted
    assert [n["start"] for n in out] == sorted(n["start"] for n in out)
