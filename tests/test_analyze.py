import soundfile as sf

from stemflipper import analyze


def test_tempo_within_2bpm(fixture_song):
    y, sr = sf.read(fixture_song["paths"]["mix"])
    tempo, beats = analyze.estimate_tempo(y, sr)
    assert abs(tempo - 120.0) <= 2.0, f"tempo {tempo} not within 120±2"
    assert len(beats) > 20


def test_key_is_a_minor_or_relative(fixture_song):
    y, sr = sf.read(fixture_song["paths"]["mix"])
    key = analyze.estimate_key(y, sr)
    # fixture is A minor; relative-major confusion (C major) is acceptable
    assert key in ("A minor", "C major"), f"unexpected key: {key}"


def test_analyze_audio_bundle(fixture_song):
    y, sr = sf.read(fixture_song["paths"]["mix"])
    result = analyze.analyze_audio(y, sr)
    assert abs(result.duration - 16.0) < 0.05
    assert result.sr == sr
    assert result.time_signature == "4/4"
