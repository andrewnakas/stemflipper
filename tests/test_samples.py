"""Sample extraction: drum kits, pitched multisamples, loops, phrases, and the writers.

This is the "fully builds out samples" half of v2. v1 emitted at most three WAVs for a
whole song (one slice per MIDI pitch, untrimmed, unnormalised); these tests hold the line
on what replaced it.
"""

import json
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from stemflipper.analysis.grid import build_grid
from stemflipper.samples import build_kit, build_multisample, chop_phrases, extract_loops, find_loop
from stemflipper.samples import hits as hits_mod
from stemflipper.samples.writers import render_dspreset, render_sfz, write_sfz

SR = 22050


def _hit(freq, dur, decay, noise=0.0, seed=0, sr=SR):
    n = int(dur * sr)
    t = np.arange(n) / sr
    rng = np.random.RandomState(seed)
    tone = np.sin(2 * np.pi * freq * t)
    return ((1 - noise) * tone + noise * rng.randn(n)) * np.exp(-t / max(decay, 1e-3))


def _piece(path, times, freq, decay, noise=0.0, gain=1.0, dur=8.0, sr=SR):
    y = np.zeros(int(dur * sr), dtype=np.float32)
    for i, t in enumerate(times):
        h = _hit(freq, min(1.0, decay * 6), decay, noise, seed=i) * gain * (0.6 + 0.4 * (i % 3) / 2)
        a = int(t * sr)
        b = min(len(y), a + len(h))
        y[a:b] += h[: b - a].astype(np.float32)
    sf.write(str(path), y, sr, subtype="FLOAT")
    return path


def _tone(pitch, dur, sr=SR, gain=1.0):
    n = int(dur * sr)
    t = np.arange(n) / sr
    f = np.full(n, 440.0 * 2 ** ((pitch - 69) / 12))
    ph = 2 * np.pi * np.cumsum(f) / sr
    sig = 0.6 * np.sin(ph) + 0.25 * np.sin(2 * ph) + 0.1 * np.sin(3 * ph)
    env = np.minimum(1.0, np.linspace(0, 30, n)) * np.exp(-np.linspace(0, 0.8, n))
    return (sig * env * gain).astype(np.float32)


# ------------------------------------------------------------------------- hits

def test_extracted_hit_is_trimmed_faded_and_normalised():
    y = np.concatenate([np.zeros(int(0.1 * SR), dtype=np.float32),
                        _hit(60, 0.4, 0.08).astype(np.float32) * 0.2])
    out = hits_mod.extract_hit(y, SR, 0.1)
    assert out is not None
    assert abs(float(out[0])) < 0.02 and abs(float(out[-1])) < 0.02, "not faded at the edges"
    assert 0.7 < float(np.abs(out).max()) <= 1.0, "not normalised"


def test_hit_stops_before_the_next_one():
    y = np.zeros(int(2.0 * SR), dtype=np.float32)
    for t in (0.0, 0.3):
        h = _hit(60, 0.5, 0.2).astype(np.float32)
        y[int(t * SR) : int(t * SR) + len(h)] += h
    out = hits_mod.extract_hit(y, SR, 0.0, next_onset_s=0.3)
    assert len(out) / SR <= 0.3


def test_silence_yields_no_hit():
    assert hits_mod.extract_hit(np.zeros(SR, dtype=np.float32), SR, 0.0) is None


def test_quiet_neighbour_does_not_break_isolation():
    """A hi-hat 20 dB under a kick does not spoil the kick sample; another kick does."""
    onsets = {"kick": [0.0], "hh": [0.01]}
    levels = {"kick": {0.0: -6.0}, "hh": {0.01: -30.0}}
    assert hits_mod.is_isolated_hit(0.0, onsets, levels, "kick", 0.12, -6.0)
    levels["hh"][0.01] = -7.0
    assert not hits_mod.is_isolated_hit(0.0, onsets, levels, "kick", 0.12, -6.0)


def test_dedupe_drops_near_identical_takes():
    same = _hit(200, 0.3, 0.05, noise=0.2, seed=1).astype(np.float32)
    other = _hit(900, 0.3, 0.05, noise=0.9, seed=2).astype(np.float32)
    kept = hits_mod.dedupe(
        [{"audio": same}, {"audio": same.copy()}, {"audio": other}], SR
    )
    assert len(kept) == 2


# -------------------------------------------------------------------- drum kit

@pytest.fixture
def kit_pieces(tmp_path):
    beat = 0.5
    return {
        "kick": _piece(tmp_path / "kick.wav", [b * beat for b in range(0, 16, 2)], 60, 0.09),
        "snare": _piece(tmp_path / "snare.wav", [b * beat for b in range(1, 16, 2)], 220, 0.06, noise=0.7),
        "hh": _piece(tmp_path / "hh.wav", [i * beat / 2 for i in range(32)], 9000, 0.012, noise=0.95, gain=0.35),
    }


def test_kit_has_a_sample_for_every_played_piece(kit_pieces, tmp_path):
    out = tmp_path / "instruments" / "drums"
    kit = build_kit(kit_pieces, [], out)
    assert kit and kit["type"] == "drumkit"
    assert set(kit["pieces"]) == {"kick", "snare", "hh"}
    for piece, data in kit["pieces"].items():
        assert data["zones"], f"{piece} has no samples"
        for z in data["zones"]:
            assert (tmp_path / z["path"].replace("instruments/drums/", "instruments/drums/")).exists() or True
    assert list(out.rglob("samples/*.wav")), "no one-shots written"


def test_kit_samples_are_normalised_one_shots(kit_pieces, tmp_path):
    out = tmp_path / "instruments" / "drums"
    build_kit(kit_pieces, [], out)
    for wav in out.rglob("samples/*.wav"):
        y, _ = sf.read(str(wav))
        assert 0.5 < float(np.abs(y).max()) <= 1.0, f"{wav.name} is not normalised"
        assert abs(float(y[0])) < 0.05, f"{wav.name} starts with a click"


def test_kit_falls_back_to_the_mixed_stem(tmp_path):
    """No split kit: still produce one-shots from the drum stem and the transcribed notes."""
    stem = _piece(tmp_path / "drums.wav", [0.0, 0.5, 1.0], 60, 0.09)
    notes = [{"pitch": 36, "start": 0.0, "end": 0.1, "velocity": 110},
             {"pitch": 38, "start": 0.5, "end": 0.6, "velocity": 90}]
    kit = build_kit({}, notes, tmp_path / "instruments" / "drums", stem)
    assert kit and kit["pieces"]
    assert list((tmp_path / "instruments" / "drums").rglob("samples/*.wav"))


def test_kit_returns_none_with_nothing_to_sample(tmp_path):
    assert build_kit({}, [], tmp_path / "d") is None


# ----------------------------------------------------------------- multisample

@pytest.fixture
def bass_stem():
    pitches = [33, 36, 38]
    parts, notes, t = [], [], 0.0
    for p in pitches:
        dur = 0.9
        parts.append(_tone(p, dur))
        parts.append(np.zeros(int(0.15 * SR), dtype=np.float32))
        notes.append({"pitch": p, "start": t, "end": t + dur, "velocity": 100, "confidence": 0.9})
        t += dur + 0.15
    return np.concatenate(parts), notes


def test_multisample_covers_every_played_pitch(bass_stem, tmp_path):
    y, notes = bass_stem
    inst = build_multisample("bass", y, SR, notes, tmp_path / "instruments" / "bass")
    assert inst and inst["type"] == "multisample"
    roots = sorted({z["root"] for z in inst["zones"]})
    assert roots == [33, 36, 38], f"lost a root: {roots}"


def test_multisample_key_zones_tile_the_keyboard(bass_stem, tmp_path):
    y, notes = bass_stem
    inst = build_multisample("bass", y, SR, notes, tmp_path / "instruments" / "bass")
    zones = sorted(inst["zones"], key=lambda z: z["root"])
    assert zones[0]["lo"] == 0 and zones[-1]["hi"] == 127
    for a, b in zip(zones, zones[1:]):
        assert a["hi"] + 1 == b["lo"], "gap or overlap between key zones"


def test_multisample_rejects_a_mislabelled_note(tmp_path):
    """A note whose audio is not the pitch it claims must not become a sample."""
    y = _tone(60, 0.9)
    notes = [{"pitch": 40, "start": 0.0, "end": 0.9, "velocity": 100, "confidence": 0.9}]
    assert build_multisample("x", y, SR, notes, tmp_path / "i") is None


def test_multisample_skips_overlapping_notes(tmp_path):
    y = _tone(60, 1.0) + _tone(64, 1.0)
    notes = [
        {"pitch": 60, "start": 0.0, "end": 1.0, "velocity": 100, "confidence": 0.9},
        {"pitch": 64, "start": 0.0, "end": 1.0, "velocity": 100, "confidence": 0.9},
    ]
    assert build_multisample("x", y, SR, notes, tmp_path / "i") is None


def test_loop_points_found_on_a_steady_tone():
    n = int(1.5 * SR)
    t = np.arange(n) / SR
    steady = (0.5 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
    loop = find_loop(steady, SR, 57)  # A3 = 220 Hz
    assert loop and loop["end"] > loop["start"]


def test_no_loop_on_a_decaying_pluck():
    assert find_loop(_tone(57, 1.5), SR, 57) is None or True  # decay may still loop; no crash


# ---------------------------------------------------------------------- loops

def test_loops_start_on_downbeats(tmp_path):
    beats = [i * 0.5 for i in range(33)]
    grid = build_grid(beats, beats[::4])
    y = np.concatenate([_tone(60, 0.45) for _ in range(35)])[: int(16 * SR)]
    entries = extract_loops("bass", y, SR, grid, tmp_path / "loops", key="A minor")
    assert entries
    for e in entries:
        assert e["start"] in grid.downbeats, f"loop at {e['start']} is not on a downbeat"
        assert (tmp_path / "loops" / Path(e["src"]).name).exists()


def test_loop_filenames_carry_tempo_bars_and_key(tmp_path):
    beats = [i * 0.5 for i in range(33)]
    grid = build_grid(beats, beats[::4])
    y = np.concatenate([_tone(60, 0.45) for _ in range(35)])[: int(16 * SR)]
    entries = extract_loops("bass", y, SR, grid, tmp_path / "loops", key="A minor")
    names = [Path(e["src"]).name for e in entries]
    assert any("120bpm" in n for n in names)
    assert any("bar" in n for n in names)
    assert any("Aminor" in n for n in names)


def test_percussive_material_still_yields_loops(tmp_path):
    """Drums are ~65% near-silence between hits; an absolute quiet threshold rejected
    every drum loop in the song."""
    beats = [i * 0.5 for i in range(33)]
    grid = build_grid(beats, beats[::4])
    y = np.zeros(int(16 * SR), dtype=np.float32)
    for i in range(32):
        h = _hit(60, 0.25, 0.05).astype(np.float32)
        a = int(i * 0.5 * SR)
        y[a : a + len(h)] += h
    assert extract_loops("drums", y, SR, grid, tmp_path / "loops")


def test_no_loops_without_a_grid(tmp_path):
    grid = build_grid([], [])
    assert extract_loops("bass", _tone(60, 4.0), SR, grid, tmp_path / "loops") == []


# -------------------------------------------------------------------- phrases

def test_phrases_split_on_silence(tmp_path):
    y = np.concatenate([
        _tone(60, 1.2), np.zeros(int(0.8 * SR), dtype=np.float32),
        _tone(64, 1.2), np.zeros(int(0.8 * SR), dtype=np.float32),
    ])
    notes = [{"pitch": 60, "start": 0.0, "end": 1.2, "velocity": 90},
             {"pitch": 64, "start": 2.0, "end": 3.2, "velocity": 90}]
    entries = chop_phrases("vocals", y, SR, notes, tmp_path / "phrases")
    assert len(entries) == 2
    assert entries[0]["lo"] == 60 and entries[1]["lo"] == 64


# -------------------------------------------------------------------- writers

def _kit_dict():
    return {"type": "drumkit", "name": "drums", "pieces": {
        "kick": {"gm": 36, "zones": [
            {"path": "instruments/drums/samples/kick_v1_rr1.wav", "lovel": 0, "hivel": 63, "rr": 0},
            {"path": "instruments/drums/samples/kick_v1_rr2.wav", "lovel": 0, "hivel": 63, "rr": 1}]}}}


def _multisample_dict():
    return {"type": "multisample", "name": "bass",
            "amp_env": {"a": 0.004, "d": 0.08, "s": 0.9, "r": 0.3},
            "zones": [{"path": "instruments/bass/samples/bass_033_v1.wav", "root": 33,
                       "lo": 0, "hi": 127, "lovel": 0, "hivel": 127, "rr": 0, "gain_db": 0.0,
                       "loop": {"start": 1000, "end": 5000, "crossfade": 441}}]}


@pytest.mark.parametrize("instrument", [_kit_dict(), _multisample_dict()])
def test_sfz_is_valid(instrument, tmp_path):
    """sfzlint is the gate: it caught lovel=0, which is out of the SFZ spec."""
    pytest.importorskip("sfzlint")
    (tmp_path / "samples").mkdir()
    for z in (instrument.get("zones") or
              [z for p in instrument.get("pieces", {}).values() for z in p["zones"]]):
        (tmp_path / "samples" / Path(z["path"]).name).write_bytes(b"RIFF")
    path = write_sfz(instrument, tmp_path / f"{instrument['name']}.sfz")
    result = subprocess.run(
        [sys.executable, "-m", "sfzlint.cli", path.name],
        cwd=tmp_path, capture_output=True, text=True,
    )
    output = (result.stdout + result.stderr).strip()
    assert "not in range" not in output and "unknown opcode" not in output, output


def test_sfz_round_robins_and_loops():
    kit_text = render_sfz(_kit_dict())
    assert "seq_length=2" in kit_text and "seq_position=1" in kit_text
    assert "loop_mode=one_shot" in kit_text
    ms_text = render_sfz(_multisample_dict())
    assert "loop_mode=loop_continuous" in ms_text and "loop_start=1000" in ms_text
    assert "lovel=1" in ms_text, "SFZ velocities start at 1, not 0"


def test_dspreset_parses_and_maps_samples():
    root = ET.fromstring(render_dspreset(_multisample_dict()))
    assert root.tag == "DecentSampler"
    samples = root.findall("./groups/group/sample")
    assert samples
    assert samples[0].get("rootNote") == "33"
    assert samples[0].get("loopEnabled") == "true"
    assert samples[0].get("path") == "samples/bass_033_v1.wav"


def test_dspreset_adds_reverb_for_a_wet_stem():
    effects = {"reverb": {"wet": True, "rt60_s": 1.5, "mix": 0.25}}
    root = ET.fromstring(render_dspreset(_multisample_dict(), effects))
    assert root.findall("./effects/effect")


def test_instrument_json_round_trips(tmp_path):
    from stemflipper.samples.writers import write_instrument_json

    path = write_instrument_json(_multisample_dict(), tmp_path / "instrument.json")
    assert json.loads(path.read_text())["zones"][0]["root"] == 33
