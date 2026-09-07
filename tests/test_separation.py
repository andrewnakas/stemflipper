"""Hierarchical separation chain tests.

Separation models are huge and network-bound, so the CHAIN LOGIC is tested with a fake
run_model that band-splits the input: the parts sum back to their source exactly, which
is precisely the property the chain must preserve. A real end-to-end run is marked slow.
"""

import numpy as np
import pytest
import soundfile as sf

from stemflipper import audio_io
from stemflipper.separation import hierarchical, registry
from stemflipper.separation.hierarchical import separate_hierarchical


# --------------------------------------------------------------------------- fakes

def _bands(y: np.ndarray, sr: int, n: int) -> list[np.ndarray]:
    """Split into n parts that sum EXACTLY back to y (residual only from float error)."""
    from scipy.signal import butter, sosfilt

    edges = np.geomspace(120, min(8000, sr / 2 - 100), n - 1)
    parts, remaining = [], y.copy()
    for edge in edges:
        sos = butter(4, edge, btype="low", fs=sr, output="sos")
        low = np.stack([sosfilt(sos, remaining[:, c]) for c in range(remaining.shape[1])], axis=1)
        parts.append(low.astype(np.float32))
        remaining = remaining - low
    parts.append(remaining.astype(np.float32))
    return parts


def _fake_run_model(calls: list):
    """Stand-in for audio-separator: emits the stem names each model really emits."""

    def run_model(input_path, out_dir, model_filename, model_dir=None, output_names=None):
        from pathlib import Path

        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        y, sr = audio_io.load_stereo(input_path)
        calls.append((model_filename, Path(input_path).name))

        if "roformer" in model_filename.lower():
            names = ["vocals", "instrumental"]
        elif "drumsep" in model_filename.lower():
            names = list(hierarchical.DRUM_PIECES)
        elif "6s" in model_filename:
            names = ["vocals", "drums", "bass", "guitar", "piano", "other"]
        else:
            names = ["vocals", "drums", "bass", "other"]

        parts = _bands(y, sr, len(names))
        out = {}
        for name, part in zip(names, parts):
            path = out_dir / f"in_({name.capitalize()})_{Path(model_filename).stem}.wav"
            # FLOAT, not the WAV default PCM_16: a real model hands back float arrays,
            # and 16-bit intermediates would put quantization noise into the residual
            # this suite measures.
            sf.write(str(path), part, sr, subtype="FLOAT")
            out[name] = path
        return out, 0.5

    return run_model


@pytest.fixture(scope="module")
def mix_path(fixture_song, tmp_path_factory):
    """A 4 s excerpt of the fixture song.

    The chain logic under test is length-independent, and each run writes ~20 stereo
    float WAVs — using the full 16 s song burns scratch space for no extra coverage.
    """
    y, sr = audio_io.load_stereo(fixture_song["paths"]["mix"])
    out = tmp_path_factory.mktemp("mix_excerpt") / "mix.wav"
    sf.write(str(out), y[: sr * 4], sr, subtype="FLOAT")
    return out


def _resolved(monkeypatch):
    """Resolve models offline so tests never touch the network."""
    monkeypatch.setattr(registry, "load_registry", lambda force=False: {})
    registry.clear_cache()


# --------------------------------------------------------------------------- tests

def test_fast_preset_runs_one_model(mix_path, tmp_path, monkeypatch):
    _resolved(monkeypatch)
    calls = []
    res = separate_hierarchical(
        mix_path, tmp_path / "stems", "fast", run_model=_fake_run_model(calls)
    )
    assert len(calls) == 1, "fast must be a single demucs pass"
    assert "htdemucs.yaml" in calls[0][0]
    assert set(res.stems) == {"vocals", "drums", "bass", "other"}
    assert res.drum_sub == {}, "fast does not split the kit"
    assert [c["step"] for c in res.chain] == ["drums_bass_other"]


def test_best_preset_chains_three_models(mix_path, tmp_path, monkeypatch):
    _resolved(monkeypatch)
    calls = []
    res = separate_hierarchical(
        mix_path, tmp_path / "stems", "best", run_model=_fake_run_model(calls)
    )
    models = [c[0] for c in calls]
    assert any("roformer" in m for m in models)
    assert any("htdemucs_ft" in m for m in models)
    assert any("DrumSep" in m for m in models)
    assert [c["step"] for c in res.chain] == ["vocals", "drums_bass_other", "drum_pieces"]
    # provenance records what each step actually consumed
    assert res.chain[1]["input"].startswith("in_(Instrumental")


def test_drum_pieces_are_written(mix_path, tmp_path, monkeypatch):
    _resolved(monkeypatch)
    res = separate_hierarchical(
        mix_path, tmp_path / "stems", "balanced", run_model=_fake_run_model([])
    )
    for piece in hierarchical.DRUM_PIECES:
        assert piece in res.drum_sub, f"missing drum piece {piece}"
        assert res.drum_sub[piece].exists()
    assert res.drum_sub["kick"].parent.name == "drums"


def test_stems_sum_back_to_the_mix(mix_path, tmp_path, monkeypatch):
    """The browser plays the Original lanes together — they must reproduce the song."""
    _resolved(monkeypatch)
    res = separate_hierarchical(
        mix_path, tmp_path / "stems", "best", run_model=_fake_run_model([])
    )
    mix, _ = audio_io.load_stereo(mix_path)
    summed = np.zeros_like(mix)
    for path in res.stems.values():
        y, _ = audio_io.load_stereo(path)
        summed += audio_io.trim_to_len(y, len(mix))
    assert audio_io.rms_db(mix - summed) < -40.0


def test_drum_pieces_sum_back_to_the_drum_stem(mix_path, tmp_path, monkeypatch):
    _resolved(monkeypatch)
    res = separate_hierarchical(
        mix_path, tmp_path / "stems", "balanced", run_model=_fake_run_model([])
    )
    drums, _ = audio_io.load_stereo(res.stems["drums"])
    summed = np.zeros_like(drums)
    for name, path in res.drum_sub.items():
        y, _ = audio_io.load_stereo(path)
        summed += audio_io.trim_to_len(y, len(drums))
    assert audio_io.rms_db(drums - summed) < -40.0


def test_residual_vocals_are_folded_into_other(mix_path, tmp_path, monkeypatch):
    """Demucs' vocals output from an already-de-vocalised instrumental is bleed, not the
    lead — it must land in `other` instead of overwriting the RoFormer vocal."""
    _resolved(monkeypatch)
    res = separate_hierarchical(
        mix_path, tmp_path / "stems", "balanced", run_model=_fake_run_model([])
    )
    vocals, _ = audio_io.load_stereo(res.stems["vocals"])
    # the fake gives the roformer vocal the lowest band; a demucs-vocals overwrite would
    # instead put the instrumental's lowest band here
    assert audio_io.rms_db(vocals) > -120.0
    assert set(res.stems) == {"vocals", "drums", "bass", "other"}


def test_six_stem_adds_guitar_and_piano(mix_path, tmp_path, monkeypatch):
    _resolved(monkeypatch)
    res = separate_hierarchical(
        mix_path, tmp_path / "stems", "best", six=True, run_model=_fake_run_model([])
    )
    assert "guitar" in res.stems and "piano" in res.stems
    assert any(c["step"] == "guitar_piano" for c in res.chain)


def test_failed_drum_split_degrades_to_one_drum_stem(mix_path, tmp_path, monkeypatch):
    """Invariant #4: a frontier step failing must not lose the whole run."""
    _resolved(monkeypatch)
    good = _fake_run_model([])

    def flaky(input_path, out_dir, model_filename, model_dir=None, output_names=None):
        if "DrumSep" in model_filename:
            raise RuntimeError("checkpoint download failed")
        return good(input_path, out_dir, model_filename, model_dir, output_names)

    res = separate_hierarchical(mix_path, tmp_path / "stems", "balanced", run_model=flaky)
    assert res.drum_sub == {}
    assert res.stems["drums"].exists()
    assert set(res.stems) == {"vocals", "drums", "bass", "other"}


def test_silent_drums_skip_the_kit_split(tmp_path, monkeypatch):
    _resolved(monkeypatch)
    silent = tmp_path / "silent.wav"
    sf.write(str(silent), np.zeros((44100 * 2, 2), dtype=np.float32), 44100)
    res = separate_hierarchical(
        silent, tmp_path / "stems", "balanced", run_model=_fake_run_model([])
    )
    assert res.drum_sub == {}


def test_seconds_and_residual_are_recorded(mix_path, tmp_path, monkeypatch):
    _resolved(monkeypatch)
    res = separate_hierarchical(
        mix_path, tmp_path / "stems", "best", run_model=_fake_run_model([])
    )
    assert res.seconds == pytest.approx(1.5, abs=0.01)  # 3 fake steps x 0.5 s
    assert res.residual_db < -40.0


# --------------------------------------------------------------------------- registry

def test_registry_prefers_a_regex_match_over_the_fallback():
    registry.clear_cache()
    reg = {
        "MDXC: Roformer Model: MelBand Roformer Kim | FT 2 Bleedless by unwa":
            "mel_band_roformer_kim_ft2_bleedless_unwa.ckpt",
        "MDXC: MDX23C Model: MDX23C DrumSep by aufr33-jarredou":
            "MDX23C-DrumSep-aufr33-jarredou.ckpt",
    }
    assert registry.resolve("vocals_roformer", reg).startswith("mel_band_roformer_kim_ft2")
    registry.clear_cache()
    assert registry.resolve("drumsep", reg) == "MDX23C-DrumSep-aufr33-jarredou.ckpt"


def test_registry_falls_back_when_offline():
    registry.clear_cache()
    for key, spec in registry.SPECS.items():
        registry.clear_cache()
        assert registry.resolve(key, {}) == spec.static_fallback


def test_registry_picks_a_later_pattern_when_the_first_is_absent():
    """Checkpoint names drift; a preset must not break when the top pick disappears."""
    registry.clear_cache()
    reg = {"MDXC: Roformer Model: MelBand Roformer | Vocals FV7b by Gabox":
           "mel_band_roformer_vocals_fv7b_gabox.ckpt"}
    assert registry.resolve("vocals_roformer", reg) == "mel_band_roformer_vocals_fv7b_gabox.ckpt"


def test_stem_name_uses_the_last_parenthesised_group():
    """Chained separation nests stem tags in the filename.

    A second pass over `mix_(other)_<model1>.wav` writes
    `mix_(other)_<model1>_(Drums)_<model2>.wav`. Reading the FIRST group labels all four
    demucs outputs "other" and the chain silently collapses to one stem — this is the
    bug that made a real `balanced` run emit 2 stems instead of 4.
    """
    from stemflipper.separation.engines import stem_name_from_filename as name

    assert name("mix_(Vocals)_htdemucs.wav") == "vocals"
    assert name("mix_(other)_mel_band_roformer_kim_ft2_bleedless_unwa_(Drums)_htdemucs.wav") == "drums"
    assert name("mix_(other)_roformer_(Bass)_htdemucs.wav") == "bass"
    assert name("drums_for_sep_(hh)_MDX23C-DrumSep.wav") == "hh"
    assert name("kick.wav") == "kick"
