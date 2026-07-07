"""Synth-fit — mono + synth-like stems → an editable Vital preset (M5, frontier).

Only stems the router tagged strategy=="synth-fit" enter here (monophonic AND synth-like).
Per PLAN.md §4 the honest promise is "a great editable *starting* preset, not a bit-exact
clone" — subtractive synthesis structurally cannot match every FM/wavetable timbre.

Baseline (no frontier dep): a `.vital` preset is plain JSON, so we author one directly,
**warm-started from the stem's measured character**:
    - oscillator waveform  ← spectral flatness (pure→saw-ish rich, noisy→adds a second osc)
    - filter cutoff        ← spectral centroid / brightness
    - amp envelope A/D/S/R  ← the stem's onset sharpness and sustain ratio

Optional refinement (`syntheon`, if installed and enabled): `infer_params(audio,"vital")`
can replace the warm-start; we keep it behind a flag so the stage never hard-depends on it.

Every entry point is wrapped: any failure returns None and the caller falls back to the
sampler path (Invariants #4, #7).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

# Vital preset scaffold. Vital reads JSON; a minimal preset needs a settings block with
# the modulation-source values it exposes. We set only the macro parameters we estimate
# and leave the rest at Vital's own defaults (the synth fills them in on load).
_VITAL_ENGINE_VERSION = "1.5.5"


@dataclass
class SynthFit:
    preset: dict                 # the full .vital JSON payload
    waveform: str                # human-readable warm-start choice
    source: str = "warmstart"    # "warmstart" | "syntheon"
    scores: dict = field(default_factory=dict)


# --------------------------------------------------------------- feature extraction

def _features(y: np.ndarray, sr: int) -> dict:
    """Measure the handful of cues that seed the preset."""
    import librosa

    if not len(y) or float(np.abs(y).max()) < 1e-6:
        return {}
    centroid = float(np.mean(librosa.feature.spectral_centroid(y=y, sr=sr)))
    flatness = float(np.mean(librosa.feature.spectral_flatness(y=y)))
    rms = librosa.feature.rms(y=y)[0]
    peak = float(rms.max()) or 1.0
    voiced = rms > 0.1 * peak
    v = rms[voiced] if voiced.any() else rms
    # sustain: tail energy vs peak; attack: how fast it reaches peak
    tail = v[int(len(v) * 0.4):]
    sustain = float(np.median(tail) / peak) if len(tail) else 0.0
    peak_frame = int(np.argmax(rms))
    attack_frac = peak_frame / max(1, len(rms))
    return {
        "centroid": centroid,
        "flatness": flatness,
        "sustain": sustain,
        "attack_frac": attack_frac,
    }


def _cutoff_from_centroid(centroid_hz: float, sr: int) -> float:
    """Map spectral centroid to a Vital filter-cutoff value (0..1, log-ish scale).

    Vital's cutoff knob is roughly MIDI-note scaled 20 Hz..20 kHz; we normalize the
    centroid onto [0,1] on a log axis with headroom so the filter opens above the tone.
    """
    lo, hi = 80.0, min(sr / 2.0, 18000.0)
    c = np.clip(centroid_hz * 2.5, lo, hi)         # open ~1.3 octave above centroid
    return float((np.log2(c) - np.log2(lo)) / (np.log2(hi) - np.log2(lo)))


# -------------------------------------------------------------------- preset author

def _build_preset(feats: dict, sr: int) -> tuple[dict, str, dict]:
    """Author a minimal Vital preset JSON from measured features."""
    flat = feats.get("flatness", 0.02)
    sustain = feats.get("sustain", 0.5)
    attack = feats.get("attack_frac", 0.1)
    centroid = feats.get("centroid", 2000.0)

    # waveform: purer tone → saw (rich harmonics, classic subtractive); noisier → add osc2
    if flat < 0.02:
        waveform, osc2_on = "saw", 0.0
    elif flat < 0.08:
        waveform, osc2_on = "saw+square", 1.0
    else:
        waveform, osc2_on = "saw+noise", 1.0

    cutoff = _cutoff_from_centroid(centroid, sr)
    # ADSR from envelope cues (Vital env times are ~seconds on a warped knob; keep simple)
    env_attack = float(np.clip(attack * 2.0, 0.0, 0.4))
    env_sustain = float(np.clip(sustain, 0.0, 1.0))
    env_release = float(np.clip(0.1 + sustain * 0.5, 0.02, 0.9))

    settings = {
        "osc_1_on": 1.0,
        "osc_1_level": 0.7,
        "osc_2_on": osc2_on,
        "osc_2_level": 0.4 if osc2_on else 0.0,
        "filter_1_on": 1.0,
        "filter_1_cutoff": _cutoff_to_vital_midi(cutoff),
        "filter_1_resonance": 0.3,
        "env_1_attack": env_attack,
        "env_1_decay": 0.3,
        "env_1_sustain": env_sustain,
        "env_1_release": env_release,
        "volume": 0.75,
    }
    preset = {
        "synth_version": _VITAL_ENGINE_VERSION,
        "preset_name": "StemFlipper warm-start",
        "author": "StemFlipper",
        "comments": "Best-effort synth-fit warm-start — an editable starting point, not a clone.",
        "preset_style": "",
        "settings": settings,
    }
    scores = {
        "flatness": round(flat, 5),
        "cutoff_norm": round(cutoff, 3),
        "env_attack": round(env_attack, 3),
        "env_sustain": round(env_sustain, 3),
        "env_release": round(env_release, 3),
    }
    return preset, waveform, scores


def _cutoff_to_vital_midi(norm: float) -> float:
    """Vital's filter cutoff is stored as a MIDI note number (roughly 8..136). Map [0,1]."""
    return round(8.0 + norm * (136.0 - 8.0), 3)


# -------------------------------------------------------------------- orchestration

def synth_fit(
    y: np.ndarray,
    sr: int,
    use_syntheon: bool = False,
) -> SynthFit | None:
    """Produce a Vital preset for a mono+synth stem. Never raises; None => fall back.

    use_syntheon (opt-in) tries syntheon's inferred params first, falling back to the
    warm-start on any failure or if syntheon isn't installed.
    """
    try:
        feats = _features(y, sr)
        if not feats:
            return None
        preset, waveform, scores = _build_preset(feats, sr)
        source = "warmstart"

        if use_syntheon:
            refined = _try_syntheon(y, sr)
            if refined is not None:
                preset, source = refined, "syntheon"

        return SynthFit(preset=preset, waveform=waveform, source=source, scores=scores)
    except Exception:
        return None


def _try_syntheon(y: np.ndarray, sr: int) -> dict | None:
    """Optional refiner. Returns a preset dict or None. Never raises."""
    try:
        import tempfile

        import soundfile as sf
        from syntheon import infer_params  # type: ignore

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as tmp:
            sf.write(tmp.name, y, sr)
            out = infer_params(tmp.name, "vital")
        # syntheon returns a path or dict depending on version; normalize to dict
        if isinstance(out, dict):
            return out
        if isinstance(out, (str, Path)):
            return json.loads(Path(out).read_text())
    except Exception:
        return None
    return None


def write_vital(preset: dict, out_path: str | Path) -> Path:
    """Write a .vital preset (plain JSON) to disk."""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(preset, indent=2))
    return out_path
