import json
import zipfile

import pretty_midi

from stemflipper import export
from stemflipper.analyze import Analysis


def _tracks():
    return {
        "bass": {
            "notes": [
                {"pitch": 33, "start": 0.0, "end": 0.5, "velocity": 100},
                {"pitch": 36, "start": 1.0, "end": 1.4, "velocity": 90},
            ],
            "is_drum": False,
        },
        "drums": {
            "notes": [{"pitch": 36, "start": 0.0, "end": 0.1, "velocity": 110}],
            "is_drum": True,
        },
        "vocals": {"notes": [], "is_drum": False},
    }


def test_write_midi_roundtrip(tmp_path):
    written = export.write_midi(_tracks(), 120.0, tmp_path / "midi")
    assert set(written) == {"song", "bass", "drums"}  # empty vocals omitted
    pm = pretty_midi.PrettyMIDI(str(written["song"]))
    assert abs(pm.get_tempo_changes()[1][0] - 120.0) < 0.01
    by_name = {i.name: i for i in pm.instruments}
    assert len(by_name["bass"].notes) == 2
    assert by_name["drums"].is_drum


def test_rpp_block_balanced(tmp_path):
    path = export.write_rpp(
        tmp_path, 120.0, {"bass": "stems/bass.wav", "drums": "stems/drums.wav"}, 16.0
    )
    text = path.read_text()
    opens = sum(1 for line in text.splitlines() if line.lstrip().startswith("<"))
    closes = sum(1 for line in text.splitlines() if line.strip() == ">")
    assert opens == closes, "unbalanced RPP blocks"
    assert "TEMPO 120.0 4 4" in text
    assert 'FILE "stems/bass.wav"' in text


def test_manifest_and_zip(tmp_path):
    analysis = Analysis(tempo=120.0, beat_times=[], key="A minor", duration=16.0)
    bundle = tmp_path / "song"
    bundle.mkdir()
    meta = export.make_manifest_meta("song.wav", analysis, "htdemucs", {"bass": {}})
    export.write_manifest(bundle, meta)
    export.write_readme(bundle, "song.wav", analysis)

    loaded = json.loads((bundle / "manifest.json").read_text())
    for key in ("app", "tempo", "key", "duration", "stems", "separation_model"):
        assert key in loaded
    assert "120" in (bundle / "README.txt").read_text()

    zip_path = export.zip_bundle(bundle)
    with zipfile.ZipFile(zip_path) as zf:
        assert "song/manifest.json" in zf.namelist()
