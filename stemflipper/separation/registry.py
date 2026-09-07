"""Resolve separation models by intent, not by hardcoded filename.

audio-separator's registry is community-maintained: filenames and friendly names drift
between releases, and a hardcoded checkpoint name silently breaks a preset. Each
ModelSpec therefore carries a priority list of regexes matched against the LIVE registry
(``Separator.list_supported_model_files()``) plus a static fallback filename for when the
registry can't be fetched (offline, CI, a rate-limited Hub).

Whatever actually resolved is recorded in project.json's ``separation.chain`` so a run is
always reproducible after the fact.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class ModelSpec:
    key: str
    #: regexes tried in order against the registry's friendly names (case-insensitive)
    patterns: tuple[str, ...]
    #: used when the registry is unreachable or nothing matches
    static_fallback: str
    #: what the model emits, canonical lowercase names
    stems: tuple[str, ...] = ()
    note: str = ""


# Vocals-first RoFormer: the strongest open vocal separation available through
# audio-separator. There is NO 4-stem RoFormer in the registry (they are all
# single-target), which is exactly why v2 separates hierarchically.
VOCALS_ROFORMER = ModelSpec(
    key="vocals_roformer",
    patterns=(
        r"kim.*ft.?2.*bleedless",
        r"kim.*ft.?2",
        r"bs.roformer.*vocals revive v3",
        r"melband roformer.*vocals fv7b",
        r"melband roformer.*vocals by kimberley",
        r"roformer.*vocals",
    ),
    static_fallback="mel_band_roformer_kim_ft2_bleedless_unwa.ckpt",
    stems=("vocals", "instrumental"),
    note="vocals/instrumental split",
)

DRUMSEP = ModelSpec(
    key="drumsep",
    patterns=(r"drumsep",),
    static_fallback="MDX23C-DrumSep-aufr33-jarredou.ckpt",
    stems=("kick", "snare", "toms", "hh", "ride", "crash"),
    note="drum kit piece separation",
)

DEMUCS = ModelSpec(
    key="demucs",
    patterns=(r"htdemucs$", r"demucs v4: htdemucs$"),
    static_fallback="htdemucs.yaml",
    stems=("vocals", "drums", "bass", "other"),
)

DEMUCS_FT = ModelSpec(
    key="demucs_ft",
    patterns=(r"htdemucs_ft", r"demucs v4: htdemucs_ft"),
    static_fallback="htdemucs_ft.yaml",
    stems=("vocals", "drums", "bass", "other"),
    note="bag of 4 models, ~4x slower than htdemucs",
)

DEMUCS_6S = ModelSpec(
    key="demucs_6s",
    patterns=(r"htdemucs_6s", r"demucs v4: htdemucs_6s"),
    static_fallback="htdemucs_6s.yaml",
    stems=("vocals", "drums", "bass", "guitar", "piano", "other"),
    note="adds guitar+piano; piano is documented-weak (bleed)",
)

SPECS: dict[str, ModelSpec] = {
    s.key: s for s in (VOCALS_ROFORMER, DRUMSEP, DEMUCS, DEMUCS_FT, DEMUCS_6S)
}

_registry_cache: dict[str, str] | None = None
_resolved_cache: dict[str, str] = {}


def _flatten(supported: dict) -> dict[str, str]:
    """{arch: {friendly_name: {...}}} -> {friendly_name: filename}."""
    flat: dict[str, str] = {}
    for arch, models in (supported or {}).items():
        if not isinstance(models, dict):
            continue
        for friendly, info in models.items():
            filename = None
            if isinstance(info, dict):
                filename = info.get("filename")
                if not filename:
                    files = info.get("download_files") or []
                    # prefer a checkpoint/yaml over configs
                    for f in files:
                        if str(f).endswith((".ckpt", ".yaml", ".pth", ".onnx", ".th")):
                            filename = f
                            break
            elif isinstance(info, str):
                filename = info
            if filename:
                flat[f"{arch}: {friendly}"] = filename
    return flat


def load_registry(force: bool = False) -> dict[str, str]:
    """Fetch the live model registry (network). Returns {} when unreachable."""
    global _registry_cache
    if _registry_cache is not None and not force:
        return _registry_cache
    try:
        from audio_separator.separator import Separator

        sep = Separator()
        _registry_cache = _flatten(sep.list_supported_model_files())
    except Exception as e:  # offline / rate-limited / API drift
        log.warning("separation registry unavailable (%s) — using static fallbacks", e)
        _registry_cache = {}
    return _registry_cache


def resolve(spec: ModelSpec | str, registry: dict[str, str] | None = None) -> str:
    """Model filename for a spec: first regex hit in the registry, else the fallback."""
    if isinstance(spec, str):
        spec = SPECS[spec]
    if spec.key in _resolved_cache:
        return _resolved_cache[spec.key]

    reg = registry if registry is not None else load_registry()
    filename = None
    for pattern in spec.patterns:
        rx = re.compile(pattern, re.I)
        for friendly, fname in reg.items():
            if rx.search(friendly):
                filename = fname
                break
        if filename:
            break
    if not filename:
        filename = spec.static_fallback
        if reg:
            log.warning(
                "no registry match for %s (%s) — falling back to %s",
                spec.key, spec.patterns, filename,
            )
    _resolved_cache[spec.key] = filename
    return filename


def clear_cache() -> None:
    """Drop memoised registry/resolutions (tests, or after a package upgrade)."""
    global _registry_cache
    _registry_cache = None
    _resolved_cache.clear()
