"""Beat grid, time signature, tempo map and chord estimation.

These drive the piano-roll bar lines, note quantization, loop slicing at downbeats and
the exported MIDI tempo map, so a wrong grid is worse than no grid.
"""

import numpy as np
import pytest

from stemflipper import audio_io
from stemflipper.analysis import beats as beats_mod
from stemflipper.analysis.chords import estimate_chords
from stemflipper.analysis import grid as grid_mod
from stemflipper.analysis.grid import (
    build_grid,
    infer_time_signature,
    median_bpm,
    tempo_map_from_beats,
)
from stemflipper.analysis.sections import estimate_sections


def _beats(bpm=120.0, n=33, start=0.0):
    step = 60.0 / bpm
    return [start + i * step for i in range(n)]


# ------------------------------------------------------------------ time signature

def test_four_four_is_inferred():
    b = _beats()
    assert infer_time_signature(b, b[::4]) == "4/4"


def test_three_four_is_inferred():
    b = _beats()
    assert infer_time_signature(b, b[::3]) == "3/4"


def test_six_eight_style_six_beat_bars():
    b = _beats(n=37)
    assert infer_time_signature(b, b[::6]) == "6/4"


def test_downbeat_on_every_beat_falls_back_to_four_four():
    """Beat This! marks nearly every beat a downbeat on ambiguous material — that
    carries no bar information and must not become a 1/4 time signature."""
    b = _beats()
    assert infer_time_signature(b, b) == "4/4"


def test_too_few_downbeats_falls_back():
    b = _beats()
    assert infer_time_signature(b, b[:2]) == "4/4"


def test_a_clear_majority_of_bars_wins_over_stray_ones():
    """Real downbeat tracks miss a bar here and there; a 3-of-5 majority is still 3/4."""
    b = _beats()
    mostly_three = [b[0], b[3], b[7], b[10], b[16], b[19]]  # 3,4,3,6,3 beats per bar
    assert infer_time_signature(b, mostly_three) == "3/4"


def test_bars_with_no_majority_fall_back():
    b = _beats(n=41)
    ragged = [b[0], b[3], b[7], b[12], b[18], b[25], b[33]]  # 3,4,5,6,7,8 — no mode
    assert infer_time_signature(b, ragged) == "4/4"


# ------------------------------------------------------------------------ tempo

def test_median_bpm_is_exact_on_a_steady_grid():
    assert median_bpm(_beats(128.0)) == pytest.approx(128.0, abs=0.01)


def test_median_bpm_octave_clamps_a_half_time_read():
    """35 BPM is below the musical band, so it doubles to 70 (not exactly, floating
    point) — the point is the clamp fires and stays inside the band."""
    bpm = median_bpm(_beats(35.0))
    assert bpm == pytest.approx(70.0, abs=0.01)
    assert grid_mod._MIN_BPM <= bpm <= grid_mod._MAX_BPM


def test_median_bpm_octave_clamps_a_double_time_read():
    bpm = median_bpm(_beats(300.0))
    assert bpm == pytest.approx(150.0, abs=0.01)


def test_steady_tempo_gives_one_breakpoint():
    assert len(tempo_map_from_beats(_beats(120.0))) == 1


def test_accelerando_gives_a_rising_tempo_map():
    beats, t = [0.0], 0.0
    for i in range(40):
        t += 0.6 * (0.985 ** i)
        beats.append(t)
    points = tempo_map_from_beats(beats)
    assert len(points) > 3
    assert points[-1][1] > points[0][1] * 1.15  # tempo genuinely rises


# ------------------------------------------------------------- seconds <-> beats

def test_seconds_to_beats_round_trips():
    g = build_grid(_beats(120.0), _beats(120.0)[::4])
    for t in (0.0, 0.25, 1.0, 3.7, 9.0):
        assert g.beats_to_seconds(g.seconds_to_beats(t)) == pytest.approx(t, abs=1e-6)


def test_seconds_to_beats_follows_tempo_drift():
    """A constant-BPM conversion would drift; the piecewise map must not."""
    beats = [0.0, 0.5, 1.0, 1.5, 2.5, 3.5]  # tempo halves at beat 3
    g = build_grid(beats, [0.0])
    assert g.seconds_to_beats(3.0) == pytest.approx(4.5, abs=1e-6)


def test_extrapolates_before_and_after_the_tracked_range():
    g = build_grid(_beats(120.0, n=8, start=1.0), [])
    assert g.seconds_to_beats(0.5) == pytest.approx(-1.0, abs=1e-6)
    assert g.seconds_to_beats(5.5) > 7


def test_grid_survives_a_single_beat():
    g = build_grid([0.5], [], duration=10.0, fallback_tempo=100.0)
    assert g.tempo == 100.0
    assert g.time_signature == "4/4"
    assert g.beats_per_bar == 4


# ------------------------------------------------------------------- coherence gate

def test_scattered_beats_are_rejected():
    ok, reason = beats_mod.beats_are_coherent([0.0, 0.46, 0.68, 0.96, 1.46, 1.98, 2.46, 2.56], [])
    assert not ok and "scattered" in reason


def test_steady_beats_are_accepted():
    b = _beats(120.0)
    ok, _ = beats_mod.beats_are_coherent(b, b[::4])
    assert ok


def test_gentle_drift_is_still_accepted():
    """A live take drifts; that is musical, not tracker failure."""
    beats, t = [0.0], 0.0
    for i in range(32):
        t += 0.5 * (1.0 + 0.004 * i)
        beats.append(t)
    ok, _ = beats_mod.beats_are_coherent(beats, beats[::4])
    assert ok


def test_downbeat_flood_is_rejected():
    b = _beats()
    ok, reason = beats_mod.beats_are_coherent(b, b)
    assert not ok and "bar structure" in reason


def test_best_grid_falls_back_to_librosa_on_the_synthetic_fixture(fixture_song):
    """The fixture is synthetic; the neural tracker mis-locks on it, and the pipeline
    must notice and use librosa rather than quantizing everything to a bad grid."""
    y, sr = audio_io.load_stereo(fixture_song["paths"]["mix"])
    beats, downbeats, source, detail = beats_mod.best_grid(y, sr)
    assert len(beats) > 8
    assert median_bpm(beats) == pytest.approx(120.0, abs=2.0)
    if source == "librosa":
        assert detail  # says why the neural grid was not used


# ---------------------------------------------------------------------- chords

def test_chords_cover_the_fixture_timeline(fixture_song):
    y, sr = audio_io.load_stereo(fixture_song["paths"]["mix"])
    chords = estimate_chords(y, sr, _beats(120.0, n=33))
    assert chords, "no chords estimated"
    assert chords[0]["start"] == pytest.approx(0.0, abs=0.01)
    for c in chords:
        assert c["end"] > c["start"]
        assert 0 <= c["root"] <= 11
        assert 0.0 <= c["conf"] <= 1.0


def test_chords_are_diatonic_to_the_fixture_key(fixture_song):
    """The fixture riffs on A/C/D — every detected root should sit in A minor."""
    y, sr = audio_io.load_stereo(fixture_song["paths"]["mix"])
    chords = estimate_chords(y, sr, _beats(120.0, n=33))
    a_minor = {9, 11, 0, 2, 4, 5, 7}
    assert all(c["root"] in a_minor for c in chords), [c["label"] for c in chords]


def test_chords_need_a_beat_grid():
    assert estimate_chords(np.zeros((44100, 2), dtype=np.float32), 44100, [0.0]) == []


def test_silence_yields_no_chords():
    silence = np.zeros((44100 * 4, 2), dtype=np.float32)
    assert estimate_chords(silence, 44100, _beats(120.0, n=8)) == []


# --------------------------------------------------------------------- sections

def test_short_songs_get_no_sections(fixture_song):
    y, sr = audio_io.load_stereo(fixture_song["paths"]["mix"])
    assert estimate_sections(y, sr, _beats(120.0, n=9)[::4], 16.0) == []


def test_sections_never_raise_on_garbage():
    assert estimate_sections(np.zeros((100, 2), dtype=np.float32), 44100, [], 120.0) == []
