import json
import shutil
import zipfile

import numpy as np
import pytest
import soundfile as sf

from stemflipper.pipeline import run_pipeline


def _fake_separator(fixture_song):
    """Stand-in for htdemucs: copies the fixture's true stems (lead -> other) and
    adds a silent vocals stem, so the whole orchestration runs in seconds."""

    def separate_fn(input_path, output_dir, model=None, model_dir=None):
        mapping = {"drums": "drums", "bass": "bass", "other": "lead"}
        out = {}
        for stem, src in mapping.items():
            target = output_dir / f"raw_{stem}.wav"
            shutil.copy(fixture_song["paths"][src], target)
            out[stem] = target
        silent = output_dir / "raw_vocals.wav"
        sf.write(str(silent), np.zeros(44100), 44100)
        out["vocals"] = silent
        return out

    return separate_fn


def _assert_complete_bundle(result, expect_tempo=120.0, tol=3.0):
    bundle = result["bundle_dir"]
    manifest = json.loads((bundle / "manifest.json").read_text())
    assert abs(manifest["tempo"] - expect_tempo) <= tol
    assert (bundle / "README.txt").exists()
    assert (bundle / "project.RPP").exists()
    assert (bundle / "midi" / "song.mid").exists()
    stems = list((bundle / "stems").glob("*.wav"))
    assert len(stems) >= 4
    sfzs = list(bundle.glob("instruments/*/*.sfz"))
    assert sfzs, "no sampler instruments built"
    with zipfile.ZipFile(result["zip_path"]) as zf:
        assert any(n.endswith("manifest.json") for n in zf.namelist())


def test_pipeline_with_stubbed_separation(fixture_song, tmp_path):
    result = run_pipeline(
        fixture_song["paths"]["mix"],
        tmp_path / "out",
        progress=lambda f, d: None,
        separate_fn=_fake_separator(fixture_song),
    )
    _assert_complete_bundle(result)
    manifest = result["manifest"]
    assert manifest["stems"]["vocals"]["silent"] is True
    assert manifest["stems"]["vocals"]["n_notes"] == 0
    assert manifest["stems"]["bass"]["n_notes"] > 0


def test_pipeline_emits_m5_effects_and_synthfit(fixture_song, tmp_path):
    """M5 wiring: every pitched stem gets an effects/*.json; the mono-synth 'other'
    stem (the fixture's sustained-saw lead) routes to synth-fit and gets a .vital.

    use_panns=False so routing uses spectral cues — PANNs isn't trained on the bare
    synthetic saw and mislabels it (the router matrix is validated offline for the same
    reason); this also mirrors the Space's PANNs-off default."""
    result = run_pipeline(
        fixture_song["paths"]["mix"],
        tmp_path / "out",
        progress=lambda f, d: None,
        separate_fn=_fake_separator(fixture_song),
        use_panns=False,
    )
    bundle = result["bundle_dir"]
    manifest = result["manifest"]

    # effects json exists for a pitched stem and is referenced in the manifest
    bass_fx = manifest["stems"]["bass"]["effects"]
    assert bass_fx == "effects/bass.json"
    assert (bundle / bass_fx).exists()
    import json as _json

    fx = _json.loads((bundle / bass_fx).read_text())
    assert "eq_curve" in fx and fx["eq_curve"]

    # drums and silent vocals are skipped (no EQ-match / synth-fit)
    assert manifest["stems"]["drums"]["effects"] is None
    assert manifest["stems"]["vocals"]["effects"] is None
    assert manifest["stems"]["vocals"]["instrument_vital"] is None

    # the sustained-saw lead -> synth-fit -> a loadable .vital
    other = manifest["stems"]["other"]
    assert other["strategy"] == "synth-fit", f"expected synth-fit, got {other['strategy']}"
    assert other["instrument_vital"] == "instruments/other/other.vital"
    vital = bundle / other["instrument_vital"]
    assert vital.exists()
    _json.loads(vital.read_text())  # loadable JSON preset


@pytest.mark.slow
def test_pipeline_end_to_end_real_separation(fixture_song, tmp_path):
    """Real htdemucs on the 16 s fixture. Downloads weights on first run (cached in
    ~/.cache/stemflipper/models); ~1-2 min on Apple Silicon CPU."""
    result = run_pipeline(
        fixture_song["paths"]["mix"], tmp_path / "out", progress=lambda f, d: None
    )
    _assert_complete_bundle(result)
