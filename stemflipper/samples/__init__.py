"""Sample extraction: drum kits, pitched multisamples, bar loops, vocal phrases."""

from .drumkit import build_kit  # noqa: F401
from .loops import extract_loops  # noqa: F401
from .multisample import build_multisample, find_loop  # noqa: F401
from .phrases import chop_phrases  # noqa: F401

__all__ = ["build_kit", "build_multisample", "find_loop", "extract_loops", "chop_phrases"]
