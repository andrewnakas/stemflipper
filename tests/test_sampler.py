from stemflipper import sampler


def test_pitched_sampler_from_bass(fixture_song, tmp_path):
    truth = fixture_song["truth"]["tracks"]["bass"]
    notes = [{**n, "velocity": 100} for n in truth]
    built = sampler.build_sampler(
        "bass", fixture_song["paths"]["bass"], notes, tmp_path / "bass"
    )
    assert built is not None
    assert built["n_regions"] == 3  # three distinct pitches in the riff
    text = built["sfz"].read_text()
    assert "pitch_keycenter=33" in text
    assert "lokey=0" in text and "hikey=127" in text  # full keyboard coverage
    wavs = list(built["samples_dir"].glob("*.wav"))
    assert len(wavs) == 3


def test_drum_sampler_one_shot(fixture_song, tmp_path):
    truth = fixture_song["truth"]["tracks"]["drums"]
    notes = [{**n, "velocity": 100} for n in truth]
    built = sampler.build_sampler(
        "drums", fixture_song["paths"]["drums"], notes, tmp_path / "drums", is_drum=True
    )
    assert built is not None
    text = built["sfz"].read_text()
    assert "loop_mode=one_shot" in text
    # drum regions map one key each
    assert "lokey=36 hikey=36" in text
    assert "lokey=42 hikey=42" in text


def test_empty_notes_returns_none(fixture_song, tmp_path):
    assert sampler.build_sampler("x", fixture_song["paths"]["bass"], [], tmp_path) is None
