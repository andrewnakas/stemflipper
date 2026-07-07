import json

import numpy as np
import pretty_midi
import soundfile as sf


def test_fixture_files_exist(fixture_song):
    for key in ("mix", "drums", "bass", "lead"):
        path = fixture_song["paths"][key]
        assert path.exists(), f"missing {key}"
        audio, sr = sf.read(path)
        assert sr == 44100
        assert abs(len(audio) / sr - 16.0) < 0.01
        assert np.abs(audio).max() > 0.1, f"{key} is silent"


def test_fixture_ground_truth(fixture_song):
    truth = json.loads((fixture_song["dir"] / "ground_truth.json").read_text())
    assert truth["tempo"] == 120.0
    assert len(truth["tracks"]["drums"]) == 8 * (2 + 2 + 8)
    assert len(truth["tracks"]["bass"]) == 8 * 3
    assert len(truth["tracks"]["lead"]) == 4 * 8

    pm = pretty_midi.PrettyMIDI(str(fixture_song["dir"] / "ground_truth.mid"))
    by_name = {inst.name: inst for inst in pm.instruments}
    assert by_name["drums"].is_drum
    for name in ("drums", "bass", "lead"):
        assert len(by_name[name].notes) == len(truth["tracks"][name])


def test_fixture_deterministic(tmp_path):
    from make_fixture import build_fixture

    a = build_fixture(tmp_path / "a")
    b = build_fixture(tmp_path / "b")
    wav_a, _ = sf.read(a["paths"]["mix"])
    wav_b, _ = sf.read(b["paths"]["mix"])
    assert np.array_equal(wav_a, wav_b)
