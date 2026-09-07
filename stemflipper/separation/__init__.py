"""Separation engines: model registry, single-model runner, hierarchical chain."""

# Import torch eagerly, at module scope, BEFORE anything imports audio_separator.
# audio-separator imports torch at its own module level; when that happens for the first
# time from deep inside a call stack (pipeline -> neural -> engines), torch 2.14 hits an
# internal circular import ("partially initialized module 'torch' has no attribute
# '_logging'") and leaves a broken half-initialised module in sys.modules, which then
# poisons every later import. Importing it here, from a clean top-level context, avoids
# the whole class of failure. torch is already a hard dependency of audio-separator.
try:  # pragma: no cover - environment guard
    import torch  # noqa: F401
except Exception:  # torch missing entirely: let the real import raise a useful error later
    pass


from .hierarchical import (  # noqa: F401
    DEFAULT_PRESET,
    DRUM_PIECES,
    MAIN_STEMS,
    PRESETS,
    SeparationResult,
    separate_hierarchical,
)
from .registry import SPECS, ModelSpec, resolve  # noqa: F401

__all__ = [
    "PRESETS", "DEFAULT_PRESET", "DRUM_PIECES", "MAIN_STEMS",
    "SeparationResult", "separate_hierarchical", "SPECS", "ModelSpec", "resolve",
]
