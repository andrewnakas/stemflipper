"""project.json contract tests — the one interface the web app depends on.

If these drift, the frontend breaks silently, so validate_project() is the guard and
these tests are its teeth.
"""

import json

import pytest

from stemflipper.export import project_json as pj


def _minimal_project(**over):
    tracks = [
        pj.track_entry(
            "bass",
            audio={"path": "stems/bass.flac", "silent": False, "peak_db": -3.0, "lufs": -18.0},
            notes=[{"pitch": 33, "start": 0.0, "end": 0.5, "velocity": 100}],
            midi="midi/bass.mid",
        )
    ]
    kwargs = dict(
        source_file="song.mp3",
        duration=16.0,
        sample_rate=44100,
        grid=pj.grid_entry(120.0, [0.0, 0.5, 1.0], downbeats=[0.0, 2.0]),
        tracks=tracks,
    )
    kwargs.update(over)
    return pj.build_project(**kwargs)


def test_minimal_project_validates():
    assert pj.validate_project(_minimal_project()) == []


def test_schema_version_is_checked():
    p = _minimal_project()
    p["schema_version"] = 1
    assert any("schema_version" in e for e in pj.validate_project(p))


def test_missing_top_level_key_is_reported():
    p = _minimal_project()
    del p["grid"]
    assert any("missing 'grid'" in e for e in pj.validate_project(p))


def test_absolute_asset_path_is_rejected():
    """Bundle-relative paths only — an absolute path breaks the zip and the file= route."""
    p = _minimal_project()
    p["tracks"][0]["audio"]["path"] = "/tmp/leaked/bass.flac"
    assert any("bundle-relative" in e for e in pj.validate_project(p))


def test_parent_traversal_path_is_rejected():
    p = _minimal_project()
    p["tracks"][0]["instrument"]["sfz"] = "../../etc/passwd"
    assert any("bundle-relative" in e for e in pj.validate_project(p))


def test_bad_note_row_is_reported():
    p = _minimal_project()
    p["tracks"][0]["notes"] = [[60, 0.0, 1.0]]  # 3 elements, not 5
    assert any("notes[0]" in e for e in pj.validate_project(p))


def test_reversed_note_is_reported():
    p = _minimal_project()
    p["tracks"][0]["notes"] = [[60, 1.0, 0.5, 100, 0.9]]
    assert any("before start" in e for e in pj.validate_project(p))


def test_bad_stage_status_is_reported():
    p = _minimal_project(stages=[{"name": "separate", "status": "sortof", "seconds": 1, "detail": ""}])
    assert any("bad status" in e for e in pj.validate_project(p))


def test_bad_track_kind_is_reported():
    p = _minimal_project()
    p["tracks"][0]["kind"] = "guitarish"
    assert any("kind" in e for e in pj.validate_project(p))


def test_missing_asset_on_disk_is_reported(tmp_path):
    p = _minimal_project()
    assert any("missing asset" in e for e in pj.validate_project(p, tmp_path))
    (tmp_path / "stems").mkdir()
    (tmp_path / "stems" / "bass.flac").write_bytes(b"x")
    (tmp_path / "midi").mkdir()
    (tmp_path / "midi" / "bass.mid").write_bytes(b"x")
    assert pj.validate_project(p, tmp_path) == []


def test_note_rows_round_trip():
    notes = [{"pitch": 60, "start": 0.1234567, "end": 0.9, "velocity": 90, "confidence": 0.812345}]
    rows = pj.note_rows(notes)
    assert rows == [[60, 0.1235, 0.9, 90, 0.812]]
    back = pj.rows_to_notes(rows)
    assert back[0]["pitch"] == 60 and back[0]["velocity"] == 90
    assert back[0]["confidence"] == pytest.approx(0.812)


def test_note_rows_default_confidence():
    rows = pj.note_rows([{"pitch": 60, "start": 0.0, "end": 1.0, "velocity": 64}])
    assert rows[0][4] == 0.7


def test_drums_track_kind_is_inferred():
    t = pj.track_entry("drums", audio={"path": "stems/drums.flac"})
    assert t["kind"] == "drums"
    assert pj.track_entry("bass", audio={"path": "stems/bass.flac"})["kind"] == "pitched"


def test_write_project(tmp_path):
    path = pj.write_project(tmp_path, _minimal_project())
    assert path.name == "project.json"
    assert json.loads(path.read_text())["schema_version"] == pj.SCHEMA_VERSION


def test_from_v1_converts_a_real_bundle(tmp_path):
    """The P0 shim: v1 manifest + notes -> a valid v2 project."""
    manifest = {
        "version": "0.1.0",
        "source_file": "song.wav",
        "separation_model": "htdemucs",
        "tempo": 120.19,
        "key": "A minor",
        "time_signature": "4/4",
        "duration": 16.0,
        "sample_rate": 44100,
        "dawproject": "project.dawproject",
        "stems": {
            "drums": {"audio": "stems/drums.wav", "silent": False, "n_notes": 2,
                      "midi": "midi/drums.mid", "instrument_sfz": "instruments/drums/drums.sfz",
                      "instrument_vital": None, "effects": None, "strategy": "sampler",
                      "instrument": "drums", "polyphonic": False, "synth_like": False,
                      "wet": False, "router_scores": {}},
            "bass": {"audio": "stems/bass.wav", "silent": False, "n_notes": 1,
                     "midi": "midi/bass.mid", "instrument_sfz": None, "instrument_vital": None,
                     "effects": None, "strategy": "sampler", "instrument": "bass",
                     "polyphonic": False, "synth_like": False, "wet": False, "router_scores": {}},
        },
    }
    notes = {
        "duration": 16.0,
        "tempo": 120.19,
        "beats": [0.0, 0.5, 1.0],
        "time_signature": "4/4",
        "stems": {
            "drums": {"is_drum": True, "notes": [[36, 0.0, 0.1, 110], [38, 0.5, 0.6, 90]]},
            "bass": {"is_drum": False, "notes": [[33, 0.0, 0.45, 100]]},
        },
    }
    p = pj.from_v1(manifest, notes)
    assert pj.validate_project(p) == []
    assert p["grid"]["tempo"] == 120.19
    assert p["key"]["name"] == "A minor"
    by_id = {t["id"]: t for t in p["tracks"]}
    assert by_id["drums"]["kind"] == "drums"
    assert by_id["bass"]["kind"] == "pitched"
    assert len(by_id["drums"]["notes"]) == 2
    # v1 rows are 4 wide; the shim must widen them to the 5-wide contract
    assert all(len(r) == pj.NOTE_ROW_LEN for r in by_id["drums"]["notes"])
    assert by_id["drums"]["instrument"]["sfz"] == "instruments/drums/drums.sfz"
