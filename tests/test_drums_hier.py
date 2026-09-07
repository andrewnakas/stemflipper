"""Per-piece drum transcription — the v2 drum accuracy story.

Splitting the kit (P1) is what makes overlapping hits tractable: a kick and a hat in the
same 10 ms are two onsets in two different signals, not one ambiguous transient. These
tests build synthetic kit pieces so they run offline in milliseconds.
"""

import numpy as np
import pytest
import soundfile as sf

from stemflipper.transcription import drums as D


SR = 22050


def _hit(sr, freq, dur, decay, noise=0.0, seed=0):
    n = int(dur * sr)
    t = np.arange(n) / sr
    env = np.exp(-t / max(decay, 1e-3))
    rng = np.random.RandomState(seed)
    tone = np.sin(2 * np.pi * freq * t)
    return ((1 - noise) * tone + noise * rng.randn(n)) * env


def _piece(tmp_path, name, times, sr=SR, dur=8.0, freq=200.0, decay=0.08, noise=0.0, gain=1.0):
    y = np.zeros(int(dur * sr), dtype=np.float32)
    for i, t in enumerate(times):
        h = _hit(sr, freq, min(0.5, decay * 6), decay, noise, seed=i) * gain
        a = int(t * sr)
        b = min(len(y), a + len(h))
        y[a:b] += h[: b - a].astype(np.float32)
    path = tmp_path / f"{name}.wav"
    sf.write(str(path), y, sr, subtype="FLOAT")
    return path


@pytest.fixture
def kit(tmp_path):
    """kick on 1&3, snare on 2&4, hats on 8ths — 4 bars at 120 BPM."""
    beat = 0.5
    kicks = [b * beat for b in range(0, 16, 2)]
    snares = [b * beat for b in range(1, 16, 2)]
    hats = [i * beat / 2 for i in range(32)]
    return {
        "kick": _piece(tmp_path, "kick", kicks, freq=60, decay=0.09),
        "snare": _piece(tmp_path, "snare", snares, freq=220, decay=0.06, noise=0.7),
        "hh": _piece(tmp_path, "hh", hats, freq=9000, decay=0.012, noise=0.95, gain=0.5),
    }, {"kick": kicks, "snare": snares, "hh": hats}


def _by_pitch(notes, *pitches):
    return [n for n in notes if n["pitch"] in pitches]


def _recall(notes, truth, tol=0.06):
    got = sorted(n["start"] for n in notes)
    used, hit = set(), 0
    for t in truth:
        for i, g in enumerate(got):
            if i not in used and abs(g - t) <= tol:
                used.add(i)
                hit += 1
                break
    return hit / max(1, len(truth))


def test_each_piece_is_transcribed_to_its_gm_pitch(kit):
    pieces, truth = kit
    notes = D.transcribe_drums_hier(pieces)
    assert _recall(_by_pitch(notes, D.GM_KICK), truth["kick"]) >= 0.9
    assert _recall(_by_pitch(notes, D.GM_SNARE), truth["snare"]) >= 0.9
    assert _recall(_by_pitch(notes, D.GM_HAT, D.GM_HAT_OPEN), truth["hh"]) >= 0.85


def test_no_phantom_pitches_from_absent_pieces(kit, tmp_path):
    """DrumSep always emits six channels. On a kit with no cymbals or toms those hold
    only residue, and without the presence gate they produced hundreds of phantom notes
    (measured: 129 ride + 68 crash + 53 tom on a kick/snare/hat-only fixture)."""
    pieces, _ = kit
    quiet = np.random.RandomState(0).randn(int(8.0 * SR)).astype(np.float32) * 1e-4
    for name in ("ride", "crash", "toms"):
        path = tmp_path / f"{name}.wav"
        sf.write(str(path), quiet, SR, subtype="FLOAT")
        pieces[name] = path
    notes = D.transcribe_drums_hier(pieces)
    assert not _by_pitch(notes, D.GM_RIDE, D.GM_CRASH), "residue channel produced ride/crash notes"
    assert not _by_pitch(notes, D.GM_TOM_LOW, D.GM_TOM_MID, D.GM_TOM_HIGH)


def test_present_cymbal_is_kept(kit, tmp_path):
    """The gate must not suppress a cymbal the drummer actually played."""
    pieces, _ = kit
    pieces["crash"] = _piece(tmp_path, "crash", [0.0, 4.0], freq=6000, decay=0.8, noise=0.9, gain=0.9)
    notes = D.transcribe_drums_hier(pieces)
    assert _by_pitch(notes, D.GM_CRASH), "a played crash was gated out"


def test_open_and_closed_hats_are_distinguished(tmp_path):
    closed = [0.0, 0.5, 1.0]
    y = np.zeros(int(4.0 * SR), dtype=np.float32)
    for t in closed:  # short decay = closed
        h = _hit(SR, 9000, 0.1, 0.01, noise=0.95)
        a = int(t * SR)
        y[a : a + len(h)] += h.astype(np.float32)
    h = _hit(SR, 9000, 0.9, 0.30, noise=0.95)  # long decay = open
    a = int(2.0 * SR)
    y[a : a + len(h)] += h.astype(np.float32)
    path = tmp_path / "hh.wav"
    sf.write(str(path), y, SR, subtype="FLOAT")

    notes = D.transcribe_drums_hier({"hh": path})
    assert _by_pitch(notes, D.GM_HAT_OPEN), "no open hat detected"
    assert _by_pitch(notes, D.GM_HAT), "no closed hat detected"


def test_toms_split_into_pitch_buckets(tmp_path):
    times = [0.0, 0.5, 1.0, 1.5, 2.0, 2.5]
    freqs = [90, 90, 140, 140, 220, 220]
    y = np.zeros(int(4.0 * SR), dtype=np.float32)
    for t, f in zip(times, freqs):
        h = _hit(SR, f, 0.4, 0.12)
        a = int(t * SR)
        y[a : a + len(h)] += h.astype(np.float32)
    path = tmp_path / "toms.wav"
    sf.write(str(path), y, SR, subtype="FLOAT")

    notes = D.transcribe_drums_hier({"toms": path})
    pitches = {n["pitch"] for n in notes}
    assert pitches <= {D.GM_TOM_LOW, D.GM_TOM_MID, D.GM_TOM_HIGH}
    assert len(pitches) >= 2, "three distinct tom pitches collapsed into one"


def test_velocity_tracks_hit_strength(tmp_path):
    y = np.zeros(int(4.0 * SR), dtype=np.float32)
    for i, (t, gain) in enumerate([(0.0, 1.0), (1.0, 0.25)]):
        h = _hit(SR, 60, 0.3, 0.09, seed=i) * gain
        a = int(t * SR)
        y[a : a + len(h)] += h.astype(np.float32)
    path = tmp_path / "kick.wav"
    sf.write(str(path), y, SR, subtype="FLOAT")
    notes = sorted(D.transcribe_drums_hier({"kick": path}), key=lambda n: n["start"])
    assert len(notes) == 2
    assert notes[0]["velocity"] > notes[1]["velocity"] + 20


def test_silent_and_missing_pieces_never_raise(tmp_path):
    silent = tmp_path / "kick.wav"
    sf.write(str(silent), np.zeros(SR, dtype=np.float32), SR)
    assert D.transcribe_drums_hier({"kick": silent}) == []
    assert D.transcribe_drums_hier({}) == []
    assert D.transcribe_drums_hier({"kick": tmp_path / "nope.wav"}) == []


def test_drums_other_channel_is_ignored(kit, tmp_path):
    pieces, _ = kit
    pieces["drums_other"] = _piece(tmp_path, "drums_other", [0.1, 0.3], freq=300, decay=0.1)
    notes = D.transcribe_drums_hier(pieces)
    assert all(0.0 <= n["start"] for n in notes)
    assert D.GM_SNARE in {n["pitch"] for n in notes}


def test_notes_are_sorted_and_carry_confidence(kit):
    pieces, _ = kit
    notes = D.transcribe_drums_hier(pieces)
    assert notes == sorted(notes, key=lambda n: (n["start"], n["pitch"]))
    assert all(0.0 < n["confidence"] <= 1.0 for n in notes)
    assert all(n["end"] > n["start"] for n in notes)
    assert all("_piece" not in n for n in notes), "internal fields leaked into the note"
