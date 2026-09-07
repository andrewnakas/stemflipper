"""Which transcriber to use for which stem, and how much to trust the result.

v1 used basic-pitch for everything pitched and one onset heuristic for drums. v2 picks
per stem and, where two engines disagree, prefers the one that agrees with the audio:

    drums   -> per-piece onsets when the kit was split, else the v1 heuristic
    vocals  -> monophonic f0 tracking, unless the stem is genuinely polyphonic (harmony
               stacks), in which case basic-pitch
    bass    -> monophonic f0 vs basic-pitch, decided by agreement + an octave sanity check
    keys    -> ByteDance piano when the router says keys and it returns a real result
    other   -> basic-pitch
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

from . import basic_pitch as bp
from . import drums as drums_mod
from . import mono_pitch
from . import piano as piano_mod

log = logging.getLogger(__name__)

#: a bass line living outside this MIDI range is an octave error, not a bass part
_BASS_MIDI_RANGE = (24, 60)
_AGREE_TOL_S = 0.06


def _agreement(a: list[dict], b: list[dict], tol: float = _AGREE_TOL_S) -> float:
    """Fraction of `a` with a same-pitch-class partner in `b` within tol seconds."""
    if not a or not b:
        return 0.0
    starts = np.array([n["start"] for n in b])
    classes = np.array([n["pitch"] % 12 for n in b])
    hits = 0
    for n in a:
        near = np.abs(starts - n["start"]) <= tol
        if near.any() and (classes[near] == n["pitch"] % 12).any():
            hits += 1
    return hits / len(a)


def _median_pitch(notes: list[dict]) -> float:
    return float(np.median([n["pitch"] for n in notes])) if notes else 0.0


def _fix_bass_octave(notes: list[dict]) -> list[dict]:
    """Shift a whole bass line into range if the tracker locked an octave off."""
    if not notes:
        return notes
    med = _median_pitch(notes)
    lo, hi = _BASS_MIDI_RANGE
    shift = 0
    while med + shift < lo:
        shift += 12
    while med + shift > hi:
        shift -= 12
    if shift:
        log.info("bass octave corrected by %+d semitones (median %.1f)", shift, med)
        return [{**n, "pitch": int(np.clip(n["pitch"] + shift, 0, 127))} for n in notes]
    return notes


def transcribe_track(
    stem_name: str,
    audio_path: str | Path,
    y: np.ndarray | None = None,
    sr: int | None = None,
    character=None,
    sub_stems: dict | None = None,
    device: str = "cpu",
) -> dict:
    """{"notes", "is_drum", "engine", "fallback"} — never raises."""
    is_drum = stem_name == "drums"
    engine, fallback = "", None

    if is_drum:
        notes: list[dict] = []
        if sub_stems:
            try:
                notes = drums_mod.transcribe_drums_hier(sub_stems, sr)
                engine = "drums_hier"
            except Exception:
                log.exception("hierarchical drum transcription failed")
        if not notes:
            fallback = engine or None
            try:
                notes = drums_mod.transcribe_drums(audio_path)
                engine = "drums_heuristic"
            except Exception:
                log.exception("drum transcription failed")
                notes, engine = [], "none"
        return {"notes": notes, "is_drum": True, "engine": engine, "fallback": fallback}

    polyphonic = bool(getattr(character, "polyphonic", False))
    is_keys = bool(getattr(character, "is_keys", False))

    # --- keys: ByteDance piano ---------------------------------------------------
    if is_keys or stem_name == "piano":
        try:
            notes = piano_mod.transcribe_piano(audio_path, device=device)
            if notes:
                return {"notes": notes, "is_drum": False, "engine": "piano", "fallback": None}
            fallback = "piano (empty)"
        except Exception as e:
            log.info("piano transcriber unavailable (%s) — using basic-pitch", e)
            fallback = "piano (unavailable)"

    # --- basic-pitch is always computed: it is the reference the others check against
    try:
        bp_notes = bp.transcribe_pitched(audio_path, stem_name)
    except Exception:
        log.exception("basic-pitch failed on %s", stem_name)
        bp_notes = []

    # --- monophonic candidates ----------------------------------------------------
    mono_notes: list[dict] = []
    if stem_name in ("bass", "vocals") and y is not None and sr and not (
        stem_name == "vocals" and polyphonic
    ):
        try:
            mono_notes = mono_pitch.transcribe_mono(y, sr, stem_name)
        except Exception:
            log.exception("mono pitch tracking failed on %s", stem_name)

    if stem_name == "bass":
        mono_notes = _fix_bass_octave(mono_notes)
        bp_notes = _fix_bass_octave(bp_notes)

    if not mono_notes:
        return {
            "notes": bp_notes, "is_drum": False, "engine": "basic_pitch",
            "fallback": fallback or ("mono_pitch (empty)" if stem_name in ("bass", "vocals") else None),
        }
    if not bp_notes:
        return {"notes": mono_notes, "is_drum": False, "engine": "mono_pitch", "fallback": "basic_pitch (empty)"}

    # Both produced notes: keep the monophonic read unless it clearly lost the line.
    # A single-voice stem should agree strongly with basic-pitch; when it does, the mono
    # track is the better one (no octave ghosts, no fragmented sustains).
    agree = _agreement(mono_notes, bp_notes)
    sparse = len(mono_notes) < 0.3 * len(bp_notes)
    if agree >= 0.5 and not sparse:
        return {"notes": mono_notes, "is_drum": False, "engine": "mono_pitch", "fallback": "basic_pitch"}
    log.info(
        "%s: mono track rejected (agreement %.2f, %d vs %d notes) — using basic-pitch",
        stem_name, agree, len(mono_notes), len(bp_notes),
    )
    return {
        "notes": bp_notes, "is_drum": False, "engine": "basic_pitch",
        "fallback": f"mono_pitch (agreement {agree:.2f})",
    }
