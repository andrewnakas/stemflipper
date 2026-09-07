"""Per-stem transcription engines and the policy that chooses between them."""

from .basic_pitch import THRESHOLDS, transcribe_pitched  # noqa: F401
from .drums import (  # noqa: F401
    GM_CRASH, GM_HAT, GM_HAT_OPEN, GM_KICK, GM_RIDE, GM_SNARE,
    transcribe_drums, transcribe_drums_hier,
)
from .mono_pitch import f0_to_notes, pyin_f0, transcribe_mono  # noqa: F401
from .piano import transcribe_piano  # noqa: F401
from .policy import transcribe_track  # noqa: F401

__all__ = [
    "transcribe_pitched", "THRESHOLDS", "transcribe_piano",
    "transcribe_drums", "transcribe_drums_hier", "transcribe_mono", "pyin_f0",
    "f0_to_notes", "transcribe_track",
    "GM_KICK", "GM_SNARE", "GM_HAT", "GM_HAT_OPEN", "GM_RIDE", "GM_CRASH",
]
