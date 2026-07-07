import numpy as np
import soundfile as sf

from stemflipper import transcribe


def _match_rate(truth_notes, got_notes, tol_s=0.1, require_pitch=True):
    """Fraction of ground-truth notes with a transcribed note of the same pitch
    starting within tol_s."""
    if not truth_notes:
        return 1.0
    hits = 0
    for t in truth_notes:
        for g in got_notes:
            if require_pitch and g["pitch"] != t["pitch"]:
                continue
            if abs(g["start"] - t["start"]) <= tol_s:
                hits += 1
                break
    return hits / len(truth_notes)


def test_bass_pitch_match(fixture_song):
    notes = transcribe.transcribe_pitched(fixture_song["paths"]["bass"], "bass")
    truth = fixture_song["truth"]["tracks"]["bass"]
    rate = _match_rate(truth, notes)
    assert rate >= 0.8, f"bass match rate {rate:.2f} < 0.8 ({len(notes)} notes)"


def test_lead_pitch_match(fixture_song):
    notes = transcribe.transcribe_pitched(fixture_song["paths"]["lead"], "other")
    truth = fixture_song["truth"]["tracks"]["lead"]
    rate = _match_rate(truth, notes)
    assert rate >= 0.8, f"lead match rate {rate:.2f} < 0.8 ({len(notes)} notes)"


def test_drums_heuristic(fixture_song):
    notes = transcribe.transcribe_drums(fixture_song["paths"]["drums"])
    truth = fixture_song["truth"]["tracks"]["drums"]
    kicks = [n for n in truth if n["pitch"] == transcribe.GM_KICK]
    snares = [n for n in truth if n["pitch"] == transcribe.GM_SNARE]

    # overlapping hits are a documented weakness; require a usable groove skeleton
    assert _match_rate(kicks, notes, tol_s=0.05) >= 0.6
    assert _match_rate(snares, notes, tol_s=0.05) >= 0.6
    got_pitches = {n["pitch"] for n in notes}
    assert transcribe.GM_HAT in got_pitches, "no hi-hats detected"


def test_silent_stem_never_raises(tmp_path):
    silent = tmp_path / "silent.wav"
    sf.write(str(silent), np.zeros(44100), 44100)
    result = transcribe.transcribe_stem("other", silent)
    assert result["notes"] == []
    drum_result = transcribe.transcribe_stem("drums", silent)
    assert drum_result["is_drum"] and drum_result["notes"] == []
