import json
import xml.etree.ElementTree as ET
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


def _grid(bpm=120.0, n=33):
    from stemflipper.analysis.grid import build_grid

    beats = [i * 60.0 / bpm for i in range(n)]
    return build_grid(beats, beats[::4])


def test_write_midi_roundtrip(tmp_path):
    written = export.write_midi(_tracks(), _grid(), tmp_path / "midi")
    assert set(written) == {"song", "bass", "drums"}  # empty vocals omitted
    pm = pretty_midi.PrettyMIDI(str(written["song"]))
    assert abs(pm.get_tempo_changes()[1][0] - 120.0) < 0.01
    by_name = {i.name: i for i in pm.instruments}
    assert len(by_name["bass"].notes) == 2
    assert by_name["drums"].is_drum


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


def test_write_notes(tmp_path):
    path = export.write_notes(_tracks(), 16.0, tmp_path)
    payload = json.loads(path.read_text())
    assert payload["duration"] == 16.0
    assert set(payload["stems"]) == {"bass", "drums"}  # empty vocals omitted
    assert payload["stems"]["drums"]["is_drum"] is True
    row = payload["stems"]["bass"]["notes"][0]
    assert row == [33, 0.0, 0.5, 100]  # [pitch, start, end, velocity]
    # tempo/beats optional -> absent when not supplied
    assert "tempo" not in payload and "beats" not in payload


def test_write_notes_with_grid(tmp_path):
    beats = [0.0, 0.5, 1.0, 1.5, 2.0]
    path = export.write_notes(
        _tracks(), 16.0, tmp_path, tempo=120.0, beat_times=beats, time_signature="3/4"
    )
    payload = json.loads(path.read_text())
    assert payload["tempo"] == 120.0
    assert payload["beats"] == beats  # rounded seconds, preserved
    assert payload["time_signature"] == "3/4"


def test_dawproject_structure(tmp_path):
    # stems must exist on disk to be bundled into the .dawproject zip
    (tmp_path / "stems").mkdir()
    for n in ("bass", "drums"):
        (tmp_path / "stems" / f"{n}.wav").write_bytes(b"RIFF0000WAVEfmt ")
    stems = {"bass": "stems/bass.wav", "drums": "stems/drums.wav"}
    path = export.write_dawproject(_tracks(), stems, 120.0, "4/4", 16.0, tmp_path)

    with zipfile.ZipFile(path) as zf:
        names = zf.namelist()
        assert {"project.xml", "metadata.xml", "audio/bass.wav", "audio/drums.wav"} <= set(names)
        root = ET.fromstring(zf.read("project.xml"))

    assert root.tag == "Project" and root.get("version") == "1.0"
    assert [t.get("name") for t in root.iter("Track")] == ["bass", "drums"]
    # tempo in the transport
    assert any(t.get("value") == "120.0" for t in root.iter("Tempo"))
    # notes embedded, converted seconds->beats (0.5s @120bpm = 1.0 beat), vel normalized 0..1
    notes = list(root.iter("Note"))
    assert len(notes) == 3  # bass 2 + drums 1 (vocals empty)
    bass_first = notes[0]
    assert bass_first.get("time") == "0.0" and bass_first.get("duration") == "1.0"
    assert 0.0 <= float(bass_first.get("vel")) <= 1.0
    # drums land on GM channel 9
    assert any(n.get("channel") == "9" for n in notes)


def test_midi_carries_a_tempo_map_and_markers(tmp_path):
    """A song that drifts must not land progressively off the grid in a DAW."""
    import pretty_midi

    from stemflipper.analysis.grid import build_grid

    # tempo halves halfway through
    beats = [0.0, 0.5, 1.0, 1.5, 2.5, 3.5, 4.5]
    grid = build_grid(beats, [0.0, 2.5])
    written = export.write_midi(
        _tracks(), grid, tmp_path / "midi",
        sections=[{"start": 0.0, "end": 2.5, "label": "A"}, {"start": 2.5, "end": 4.5, "label": "B"}],
    )
    pm = pretty_midi.PrettyMIDI(str(written["song"]))
    _, tempi = pm.get_tempo_changes()
    assert len(tempi) >= 2, "tempo drift was flattened to a single tempo"
    assert pm.time_signature_changes


def test_midi_writes_a_chord_track(tmp_path):
    import pretty_midi

    chords = [{"start": 0.0, "end": 2.0, "label": "Am", "root": 9, "quality": "min", "conf": 0.9}]
    written = export.write_midi(_tracks(), _grid(), tmp_path / "midi", chords=chords)
    assert "chords" in written
    pm = pretty_midi.PrettyMIDI(str(written["song"]))
    chord_tracks = [i for i in pm.instruments if i.name == "Chords"]
    assert chord_tracks and len(chord_tracks[0].notes) == 3  # A minor triad


def test_drums_land_on_the_midi_drum_channel(tmp_path):
    import pretty_midi

    written = export.write_midi(_tracks(), _grid(), tmp_path / "midi")
    pm = pretty_midi.PrettyMIDI(str(written["song"]))
    drums = [i for i in pm.instruments if i.is_drum]
    assert drums, "drum track was not flagged is_drum (GM channel 10)"


def test_stems_convert_to_flac(tmp_path):
    import numpy as np
    import soundfile as sf

    stems = tmp_path / "stems"
    (stems / "drums").mkdir(parents=True)
    sf.write(str(stems / "bass.wav"), np.zeros((2205, 2), dtype=np.float32), 22050)
    sf.write(str(stems / "drums" / "kick.wav"), np.zeros((2205, 2), dtype=np.float32), 22050)
    out = export.stems_to_flac(tmp_path)
    assert (stems / "bass.flac").exists()
    assert (stems / "drums" / "kick.flac").exists()
    assert not list(stems.rglob("*.wav")), "WAV originals were left behind"
    assert out["bass"] == "stems/bass.flac"


def test_no_rpp_is_written():
    """v2 dropped the Reaper project: MIDI + DAWproject cover every DAW."""
    assert not hasattr(export, "write_rpp")
