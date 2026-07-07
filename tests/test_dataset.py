"""M6 dataset-scaffold tests — the synthetic (audio → params) moat.

Gate (PLAN.md): generate a torchsynth (audio, params) batch + a dasp (wet, params)
batch; wrap as a ``datasets.Dataset``; confirm it round-trips via ``datasets`` and
the generator reproduces audio deterministically from seeds.

All offline: torchsynth/dasp render on CPU with no downloads. These deps live in
``dataset/requirements.txt`` (NOT the app requirements) — the tests import the
``dataset/`` package directly.
"""

import numpy as np
import pytest

from dataset import build, effects_gen, synth_gen


# ------------------------------------------------------------------ synth generator

def test_synth_batch_shapes_and_determinism():
    cfg = synth_gen.SynthGenConfig(batch_size=32, batch_indices=[0])
    audio, params = synth_gen.generate_batch(cfg, 0)
    assert audio.shape == (32, cfg.sample_rate)  # buffer_size_seconds=1.0
    assert params.shape[0] == 32 and params.shape[1] == 78
    assert audio.dtype == np.float32 and params.dtype == np.float32
    # deterministic: same (cfg, batch_idx) → identical arrays
    a2, p2 = synth_gen.generate_batch(cfg, 0)
    assert np.array_equal(audio, a2) and np.array_equal(params, p2)


def test_synth_batches_differ():
    cfg = synth_gen.SynthGenConfig(batch_size=32, batch_indices=[0, 1])
    a0, _ = synth_gen.generate_batch(cfg, 0)
    a1, _ = synth_gen.generate_batch(cfg, 1)
    assert not np.array_equal(a0, a1), "different batch indices must give different audio"


def test_synth_param_names_are_self_describing():
    names = synth_gen.parameter_names()
    assert len(names) == 78
    # names are "<module>.<param>" and stable/ordered
    assert all("." in n for n in names)
    assert names == synth_gen.parameter_names(), "param name order must be stable"


def test_synth_reproducible_requires_batch_multiple_of_32():
    with pytest.raises(ValueError):
        synth_gen.SynthGenConfig(batch_size=30)


def test_synth_iter_examples_flatten():
    cfg = synth_gen.SynthGenConfig(batch_size=32, batch_indices=[0])
    exs = list(synth_gen.iter_examples(cfg))
    assert len(exs) == 32
    ex = exs[0]
    assert ex["kind"] == "synth"
    assert ex["audio"].shape == (cfg.sample_rate,)
    assert ex["params"].shape == (78,)
    assert ex["batch_idx"] == 0 and ex["item"] == 0


# ---------------------------------------------------------------- effects generator

def _dry():
    a, _ = synth_gen.generate_batch(
        synth_gen.SynthGenConfig(batch_size=32, batch_indices=[0]), 0
    )
    return a[0]


def test_effects_render_deterministic_per_seed():
    dry, sr = _dry(), 44100
    wet1, names, vals1, _ = effects_gen.render(dry, sr, effects_gen.DEFAULT_CHAIN, seed=7)
    wet2, _, vals2, _ = effects_gen.render(dry, sr, effects_gen.DEFAULT_CHAIN, seed=7)
    assert np.array_equal(wet1, wet2) and vals1 == vals2
    assert len(names) == len(vals1) == 25  # 6-band EQ(18) + comp(6) + distortion(1)


def test_effects_seeds_produce_different_params_and_audio():
    dry, sr = _dry(), 44100
    wet_a, _, vals_a, _ = effects_gen.render(dry, sr, effects_gen.DEFAULT_CHAIN, seed=7)
    wet_b, _, vals_b, _ = effects_gen.render(dry, sr, effects_gen.DEFAULT_CHAIN, seed=8)
    assert vals_a != vals_b
    assert not np.array_equal(wet_a, wet_b)


def test_effects_param_names_match_specs():
    names = effects_gen.param_names(effects_gen.DEFAULT_CHAIN)
    # every name is "<effect>.<param>" and effects appear in chain order
    assert names[0].startswith("parametric_eq.")
    assert any(n.startswith("compressor.") for n in names)
    assert names[-1] == "distortion.drive_db"


def test_effects_wet_is_peak_normalized():
    dry, sr = _dry(), 44100
    wet, _, _, peak = effects_gen.render(dry, sr, effects_gen.DEFAULT_CHAIN, seed=3)
    assert np.max(np.abs(wet)) <= 1.0 + 1e-5
    assert peak > 0


def test_effects_eq_low_shelf_boost_moves_spectrum():
    # A pure low-shelf boost (all other bands flat) must raise low-band energy.
    sr = 44100
    dry = _dry()
    import torch
    import dasp_pytorch.functional as F

    x = torch.from_numpy(dry).reshape(1, 1, -1)
    flat = dict(
        low_shelf_gain_db=12.0, low_shelf_cutoff_freq=150.0, low_shelf_q_factor=0.7,
        band0_gain_db=0.0, band0_cutoff_freq=400.0, band0_q_factor=0.7,
        band1_gain_db=0.0, band1_cutoff_freq=1000.0, band1_q_factor=0.7,
        band2_gain_db=0.0, band2_cutoff_freq=2500.0, band2_q_factor=0.7,
        band3_gain_db=0.0, band3_cutoff_freq=6000.0, band3_q_factor=0.7,
        high_shelf_gain_db=0.0, high_shelf_cutoff_freq=10000.0, high_shelf_q_factor=0.7,
    )
    y = effects_gen._apply_effect("parametric_eq", x, sr, flat)

    def low_ratio(sig):
        S = torch.abs(torch.fft.rfft(sig.flatten()))
        freqs = torch.fft.rfftfreq(sig.shape[-1], 1 / sr)
        return float(S[freqs < 200].pow(2).sum() / S.pow(2).sum().clamp_min(1e-12))

    assert low_ratio(y) > low_ratio(x), "low-shelf boost should raise sub-200Hz energy"


# ------------------------------------------------------------------- datasets gate

@pytest.fixture(scope="module")
def small_build():
    cfg = build.BuildConfig(effects_seeds=[0, 1], effects_n_dry=2, synth_batch_indices=[0])
    return cfg, build.build_all(cfg)


def test_build_all_makes_two_configs(small_build):
    _cfg, built = small_build
    assert set(built) == {"synth", "effects"}
    assert len(built["synth"]) == 32
    assert len(built["effects"]) == 4  # 2 dry × 2 seeds
    assert built["synth"][0]["params"] and len(built["synth"][0]["audio"]) == 44100
    assert len(built["effects"][0]["params"]) == 25


def test_datasets_round_trip(tmp_path, small_build):
    """Gate: save → load_from_disk returns identical audio + params."""
    from datasets import load_from_disk

    _cfg, built = small_build
    ds = built["synth"]
    ds.save_to_disk(str(tmp_path / "synth"))
    reloaded = load_from_disk(str(tmp_path / "synth"))
    assert len(reloaded) == len(ds)
    assert np.allclose(reloaded[0]["audio"], ds[0]["audio"])
    assert reloaded[0]["params"] == ds[0]["params"]


def test_deterministic_regeneration_from_seeds(small_build):
    """Gate: rebuilding from the same seeds reproduces audio bit-for-bit."""
    cfg, built = small_build
    rebuilt = build.build_all(cfg)
    assert np.array_equal(
        np.asarray(rebuilt["synth"][0]["audio"]), np.asarray(built["synth"][0]["audio"])
    )
    assert np.array_equal(
        np.asarray(rebuilt["effects"][0]["audio"]), np.asarray(built["effects"][0]["audio"])
    )


def test_card_meta_documents_seeds():
    cfg = build.BuildConfig()
    meta = cfg.to_card_meta()
    assert meta["synth"]["generator"] == "dataset/synth_gen.py"
    assert meta["effects"]["chain"] == list(effects_gen.DEFAULT_CHAIN)
    assert len(meta["effects"]["param_names"]) == 25
