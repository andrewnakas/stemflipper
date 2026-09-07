"""Hierarchical separation: the v2 quality story.

There is no 4-stem RoFormer in the audio-separator registry — the strong RoFormers are
all single-target. So "best" separation is a CHAIN, which is what the UVR/MVSEP ensembles
do in practice:

    mix ── RoFormer ──> vocals + instrumental
                          └── Demucs(_ft) ──> drums, bass, other (+ residual vocals)
                                                └── DrumSep ──> kick snare toms hh ride crash

Two properties matter downstream and are enforced here:

*   **sum-to-mix.** Whatever the chain loses is folded back into `other`, so the browser
    can play the "Original" lanes together and hear the actual song, not a thinner one.
*   **per-piece drums.** Splitting the kit is what lets v2 transcribe and sample real
    drums (per-piece onsets, isolated one-shots) without an NC-licensed ADT model.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .. import audio_io
from . import registry
from .engines import run_model as _run_model

log = logging.getLogger(__name__)

#: Ordered chain per preset. Cost/quality knob exposed in the UI and the CLI.
PRESETS: dict[str, tuple[str, ...]] = {
    "fast": ("demucs",),
    "balanced": ("vocals_roformer", "demucs", "drumsep"),
    "best": ("vocals_roformer", "demucs_ft", "drumsep"),
}
DEFAULT_PRESET = "balanced"

DRUM_PIECES = ("kick", "snare", "toms", "hh", "ride", "crash")
MAIN_STEMS = ("vocals", "drums", "bass", "other")


@dataclass
class SeparationResult:
    stems: dict[str, Path]
    drum_sub: dict[str, Path] = field(default_factory=dict)
    chain: list[dict] = field(default_factory=list)
    residual_db: float = -120.0
    seconds: float = 0.0

    @property
    def preset_stems(self) -> list[str]:
        return sorted(self.stems)


def _load(path: Path) -> tuple[np.ndarray, int]:
    return audio_io.load_stereo(path)


def _write(path: Path, y: np.ndarray, sr: int) -> Path:
    """Chain intermediates and stems stay 32-bit FLOAT.

    soundfile defaults WAV to PCM_16, which would quantize every hand-off between models
    (mix -> instrumental -> drums -> pieces) and clip any band that overshoots 0 dBFS.
    The bundle's FLAC conversion happens later, once, from these full-precision files.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    import soundfile as sf

    sf.write(str(path), y, sr, subtype="FLOAT")
    return path


def separate_hierarchical(
    input_path: str | Path,
    stems_dir: str | Path,
    preset: str = DEFAULT_PRESET,
    *,
    six: bool = False,
    model_dir: str | Path | None = None,
    run_model=_run_model,
    progress=None,
) -> SeparationResult:
    """Run the preset's chain; return canonical stems + drum pieces + provenance."""
    input_path = Path(input_path)
    stems_dir = Path(stems_dir)
    stems_dir.mkdir(parents=True, exist_ok=True)
    work = stems_dir / "_chain"
    work.mkdir(parents=True, exist_ok=True)

    steps = PRESETS.get(preset, PRESETS[DEFAULT_PRESET])
    chain: list[dict] = []
    total_seconds = 0.0

    def report(frac, msg):
        if progress is not None:
            progress(frac, msg)

    def _step(name, spec_key, src: Path, out: Path, weight=1.0):
        nonlocal total_seconds
        model = registry.resolve(spec_key)
        report(0.0, f"Separating {name} ({model})")
        stems, seconds = run_model(src, out, model, model_dir)
        total_seconds += seconds
        chain.append(
            {
                "step": name,
                "model": model,
                "input": src.stem,
                "seconds": round(seconds, 2),
            }
        )
        return stems

    mix, sr = _load(input_path)
    n = len(mix)

    # ---- step 1: vocals ---------------------------------------------------------
    if "vocals_roformer" in steps:
        vs = _step("vocals", "vocals_roformer", input_path, work / "vocals")
        vocals_path = vs.get("vocals")
        # The vocal RoFormers label their second output differently by checkpoint:
        # "Instrumental" on some, plain "other" on the unwa/Gabox ones.
        inst_path = vs.get("instrumental") or vs.get("instrument") or vs.get("other")
        if vocals_path is None or inst_path is None:
            log.warning("vocals model returned %s — falling back to demucs-only", sorted(vs))
            vocals_path = inst_path = None
    else:
        vocals_path = inst_path = None

    # ---- step 2: drums / bass / other -------------------------------------------
    demucs_key = "demucs_ft" if "demucs_ft" in steps else "demucs"
    demucs_src = Path(inst_path) if inst_path else input_path
    ds = _step("drums_bass_other", demucs_key, demucs_src, work / "demucs")

    stems_audio: dict[str, np.ndarray] = {}
    for name in ("drums", "bass", "other"):
        if name in ds:
            y, _ = _load(ds[name])
            stems_audio[name] = audio_io.trim_to_len(y, n)

    if vocals_path is not None:
        y, _ = _load(Path(vocals_path))
        stems_audio["vocals"] = audio_io.trim_to_len(y, n)
        # Demucs also emits a vocals stem from the (already de-vocalised) instrumental.
        # That is residual bleed, not the lead vocal — fold it into `other` rather than
        # discarding it, or the stems no longer sum to the mix.
        if "vocals" in ds:
            res, _ = _load(ds["vocals"])
            stems_audio["other"] = stems_audio.get("other", 0) + audio_io.trim_to_len(res, n)
    elif "vocals" in ds:
        y, _ = _load(ds["vocals"])
        stems_audio["vocals"] = audio_io.trim_to_len(y, n)

    # ---- step 2b: optional 6-stem pass over `other` ------------------------------
    if six and "other" in stems_audio:
        other_path = _write(work / "other_for6s.wav", stems_audio["other"], sr)
        try:
            s6 = _step("guitar_piano", "demucs_6s", other_path, work / "demucs6s")
            merged = np.zeros_like(stems_audio["other"])
            for name, path in s6.items():
                y, _ = _load(path)
                y = audio_io.trim_to_len(y, n)
                if name in ("guitar", "piano"):
                    stems_audio[name] = y
                else:
                    merged = merged + y  # 6s vocals/drums/bass/other residue stays in other
            stems_audio["other"] = merged
        except Exception as e:
            log.warning("6-stem pass failed (%s) — keeping the 4-stem split", e)

    # ---- step 3: drum pieces ----------------------------------------------------
    drum_sub: dict[str, Path] = {}
    if "drumsep" in steps and "drums" in stems_audio and not audio_io.is_silent(
        audio_io.to_mono(stems_audio["drums"])
    ):
        drums_path = _write(work / "drums_for_sep.wav", stems_audio["drums"], sr)
        try:
            pieces = _step("drum_pieces", "drumsep", drums_path, work / "drumsep")
            summed = np.zeros_like(stems_audio["drums"])
            for name, path in pieces.items():
                y, _ = _load(path)
                y = audio_io.trim_to_len(y, len(stems_audio["drums"]))
                summed = summed + y
                drum_sub[name] = _write(stems_dir / "drums" / f"{name}.wav", y, sr)
            leftover = stems_audio["drums"] - summed
            if audio_io.rms_db(leftover) > -40.0:
                drum_sub["drums_other"] = _write(
                    stems_dir / "drums" / "drums_other.wav", leftover, sr
                )
        except Exception as e:
            log.warning("drum separation failed (%s) — keeping the single drums stem", e)

    # ---- consistency: make the stems sum back to the mix ------------------------
    if stems_audio:
        summed = np.zeros_like(mix)
        for y in stems_audio.values():
            summed = summed + audio_io.trim_to_len(y, n)
        residual = mix - summed
        residual_db = audio_io.rms_db(residual)
        target = "other" if "other" in stems_audio else next(iter(stems_audio))
        stems_audio[target] = stems_audio[target] + residual
    else:
        raise RuntimeError("separation produced no usable stems")

    stems: dict[str, Path] = {}
    for name, y in stems_audio.items():
        stems[name] = _write(stems_dir / f"{name}.wav", y, sr)

    report(1.0, "Separation done")
    return SeparationResult(
        stems=stems,
        drum_sub=drum_sub,
        chain=chain,
        residual_db=round(residual_db, 2),
        seconds=round(total_seconds, 2),
    )
