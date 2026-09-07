"""Thin, cached wrapper around one audio-separator model run.

Generalises v1's ``separate.separate_stems``: any model, any output naming, and the
Separator instance is cached per checkpoint so a hierarchical chain that reuses a model
does not reload weights.
"""

from __future__ import annotations

import logging
import re
import time
from pathlib import Path

from ..separate import default_model_dir

log = logging.getLogger(__name__)

_SEPARATORS: dict[tuple[str, str], object] = {}


def _get_separator(model_filename: str, model_dir: str | Path, output_dir: str | Path):
    from audio_separator.separator import Separator

    key = (str(model_filename), str(model_dir))
    sep = _SEPARATORS.get(key)
    if sep is None:
        sep = Separator(
            output_dir=str(output_dir),
            model_file_dir=str(model_dir),
            output_format="WAV",
        )
        sep.load_model(model_filename=model_filename)
        _SEPARATORS[key] = sep
    else:
        # reuse the loaded weights, but write into this call's directory
        sep.output_dir = str(output_dir)
    return sep


def stem_name_from_filename(filename: str) -> str:
    """audio-separator names outputs '<base>_(Vocals)_<model>.wav' -> 'vocals'.

    Takes the LAST parenthesised group, not the first: in a chain the input file already
    carries its own stem tag, so a second pass produces names like
    ``mix_(other)_mel_band_roformer_(Drums)_htdemucs.wav``. Reading the first group there
    labels every output of the second model "other", collapsing four stems into one.
    """
    matches = re.findall(r"\(([^)]+)\)", filename)
    token = (matches[-1] if matches else Path(filename).stem).strip().lower()
    return re.sub(r"[^a-z0-9]+", "", token)


def run_model(
    input_path: str | Path,
    out_dir: str | Path,
    model_filename: str,
    model_dir: str | Path | None = None,
    output_names: dict[str, str] | None = None,
) -> tuple[dict[str, Path], float]:
    """Run one separation model.

    Returns ({stem_name: wav_path}, seconds). Stem names come from the model's own
    output naming, lowercased and stripped, so a DrumSep run yields kick/snare/toms/...
    and a Demucs run yields vocals/drums/bass/other.
    """
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    sep = _get_separator(model_filename, model_dir or default_model_dir(), out_dir)

    t0 = time.perf_counter()
    files = sep.separate(str(input_path), custom_output_names=output_names or None)
    seconds = time.perf_counter() - t0

    stems: dict[str, Path] = {}
    for f in files:
        path = Path(f)
        if not path.is_absolute():
            path = out_dir / path
        stems[stem_name_from_filename(path.name)] = path
    if not stems:
        raise RuntimeError(f"{model_filename} produced no outputs: {files}")
    log.info("%s -> %s in %.1fs", model_filename, sorted(stems), seconds)
    return stems, seconds


def clear_cache() -> None:
    _SEPARATORS.clear()
