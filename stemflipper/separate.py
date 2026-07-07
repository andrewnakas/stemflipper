"""Source separation via audio-separator (wraps Demucs v4 / MDX / BS-RoFormer).

This module is the ONLY GPU-relevant stage. app.py wraps `separate_stems` in
`@spaces.GPU` when running on ZeroGPU; everywhere else it runs as-is (CPU or CUDA,
auto-detected by audio-separator).
"""

from __future__ import annotations

import os
import re
from pathlib import Path

# canonical stem names, in bundle order
KNOWN_STEMS = ("vocals", "drums", "bass", "guitar", "piano", "other")

# model name -> audio-separator model_filename
MODELS = {
    "htdemucs": "htdemucs.yaml",        # 4 stems, default (speed / CPU-viable)
    "htdemucs_6s": "htdemucs_6s.yaml",  # 6 stems; piano documented-weak, gate it
    "htdemucs_ft": "htdemucs_ft.yaml",  # bag-of-4, ~4x slower, +0.2 dB
}
DEFAULT_MODEL = "htdemucs"


def default_model_dir() -> Path:
    env = os.environ.get("STEMFLIPPER_MODEL_DIR")
    if env:
        return Path(env)
    return Path.home() / ".cache" / "stemflipper" / "models"


def separate_stems(
    input_path: str | Path,
    output_dir: str | Path,
    model: str = DEFAULT_MODEL,
    model_dir: str | Path | None = None,
) -> dict[str, Path]:
    """Run separation; return {canonical_stem_name: wav_path}."""
    from audio_separator.separator import Separator

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    model_filename = MODELS.get(model, model)  # allow raw model filenames too

    separator = Separator(
        output_dir=str(output_dir),
        model_file_dir=str(model_dir or default_model_dir()),
        output_format="WAV",
    )
    separator.load_model(model_filename=model_filename)
    output_files = separator.separate(str(input_path))

    stems: dict[str, Path] = {}
    for f in output_files:
        path = Path(f)
        if not path.is_absolute():
            path = output_dir / path
        name = _stem_name_from_filename(path.name)
        if name:
            stems[name] = path
    if not stems:
        raise RuntimeError(f"separation produced no recognizable stems: {output_files}")
    return stems


def _stem_name_from_filename(filename: str) -> str | None:
    """audio-separator names outputs like 'song_(Vocals)_htdemucs.wav'."""
    match = re.search(r"\(([^)]+)\)", filename)
    candidate = (match.group(1) if match else filename).strip().lower()
    for stem in KNOWN_STEMS:
        if stem in candidate:
            return stem
    return None
