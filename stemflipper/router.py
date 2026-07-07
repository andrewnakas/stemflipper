"""Stem-character router — the heart of M4's "gated reconstruction" design.

For each stem it decides ONE reconstruction strategy:
    "sampler-phrase"  polyphonic (chords/pads/piano) — slice whole phrases, can't be
                      pulled apart into editable per-note synths (the hard wall)
    "synth-fit"       monophonic + synth-like — a candidate for per-note synth fitting
                      (M5, frontier); flagged here, not yet fitted
    "sampler"         monophonic + acoustic/complex — the reliable sliced-sample baseline

Inputs it combines (in priority order):
  1. polyphony    — spectral (chroma) concurrency, robust to basic-pitch ghost notes,
                    cross-checked against transcribed note overlap
  2. synth-vs-acoustic — PANNs CNN14 instrument bucket when available; falls back to
                    sustain-envelope + spectral-flatness cues (works with no network)
  3. dry-vs-wet   — reverb-tail presence (informational; surfaced in the manifest)

Every function degrades gracefully: no network / missing weights / silent stem never
raises — the router always returns a decision, defaulting to the safe "sampler" path.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

# --- thresholds (grounded on the synthetic router fixtures; see tests/make_fixture.py) ---
_POLY_CHROMA_BINS = 1.5      # mean strong simultaneous pitch classes above this => polyphonic
_POLY_NOTE_OVERLAP = 0.2     # PLAN.md's note-time-overlap cross-check
_SUSTAIN_SYNTH = 0.6         # tail/peak RMS above this => sustained (synth-like), below => decaying
_FLATNESS_SYNTH = 0.05       # noisy/rich spectrum flatness above this leans synth/electronic
_WET_DECAY_TAIL = 0.15       # post-offset energy fraction above this => wet (reverb/delay tail)

# PANNs CNN14 AudioSet label indices that read as "synthetic / electronic" sources.
# (indices confirmed against panns_inference.labels at build time)
_SYNTH_LABEL_IDS = frozenset({7, 158, 156, 163, 243})  # speech-synth, synthesizer, electronic organ, drum machine, DnB
_SYNTH_KEYWORDS = ("synthes", "electronic", "drum machine")
# keys/piano buckets -> route to the ByteDance piano transcriber
_KEYS_LABEL_IDS = frozenset({153, 154, 155, 156, 157})  # piano, electric piano, organ*, hammond
_KEYS_KEYWORDS = ("piano", "organ", "harpsichord", "clavinet", "keyboard")


@dataclass
class StemCharacter:
    strategy: str                      # "sampler" | "synth-fit" | "sampler-phrase"
    polyphonic: bool
    synth_like: bool
    wet: bool
    instrument: str = "unknown"        # PANNs top instrument label (or "unknown")
    is_keys: bool = False              # route transcription to the piano model
    scores: dict = field(default_factory=dict)  # raw measurements, for the manifest / debugging


# --------------------------------------------------------------------------- polyphony

def polyphony_estimate(y: np.ndarray, sr: int) -> float:
    """Mean number of *strong simultaneous pitch classes* over voiced frames.

    ~1.0 for a monophonic line, >=2 for chords. Uses chroma (octave-folded) so
    basic-pitch's octave/harmonic ghost notes don't inflate it.
    """
    import librosa

    if not len(y) or float(np.abs(y).max()) < 1e-5:
        return 0.0
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    rms = librosa.feature.rms(y=y)[0]
    n = min(chroma.shape[1], len(rms))
    chroma, rms = chroma[:, :n], rms[:n]
    voiced = rms > 0.15 * (rms.max() or 1.0)
    if not voiced.any():
        return 0.0
    cv = chroma[:, voiced]
    strong = (cv >= 0.5 * cv.max(axis=0, keepdims=True)).sum(axis=0)
    return float(np.mean(strong))


def note_overlap_fraction(notes: list[dict]) -> float:
    """Fraction of total note-time that overlaps a *non-octave* concurrent note.

    Octave/unison overlaps (the common basic-pitch ghost) are excluded so this
    tracks real polyphony, matching PLAN.md's >0.2 overlap rule as a cross-check.
    """
    if not notes:
        return 0.0
    events = sorted(notes, key=lambda x: x["start"])
    total = sum(max(0.0, n["end"] - n["start"]) for n in events)
    overlap = 0.0
    for i, a in enumerate(events):
        for b in events[i + 1:]:
            if b["start"] >= a["end"]:
                break
            if abs(a["pitch"] - b["pitch"]) % 12 == 0:
                continue  # octave/unison ghost — not real polyphony
            overlap += min(a["end"], b["end"]) - b["start"]
    return overlap / max(1e-9, total)


# ----------------------------------------------------------------- synth vs acoustic

def sustain_ratio(y: np.ndarray, sr: int) -> float:
    """median RMS of the later voiced portion / peak RMS.

    High (~1) => sustained tone (synth pad/lead); low (~0.3) => decaying (plucked,
    struck, or otherwise acoustic).
    """
    import librosa

    if not len(y):
        return 0.0
    rms = librosa.feature.rms(y=y)[0]
    peak = float(rms.max()) or 1.0
    voiced = rms > 0.1 * peak
    if not voiced.any():
        return 0.0
    v = rms[voiced]
    tail = v[int(len(v) * 0.4):]
    return float(np.median(tail) / peak) if len(tail) else 0.0


def spectral_flatness(y: np.ndarray, sr: int) -> float:
    """Mean spectral flatness over voiced frames. Noisy/rich spectra (many synths,
    distortion) score higher; pure harmonic tones score ~0."""
    import librosa

    if not len(y):
        return 0.0
    S = np.abs(librosa.stft(y))
    flat = librosa.feature.spectral_flatness(S=S)[0]
    rms = librosa.feature.rms(S=S)[0]
    voiced = rms > 0.15 * (rms.max() or 1.0)
    return float(np.mean(flat[voiced])) if voiced.any() else 0.0


# ------------------------------------------------------------------------- dry vs wet

def wetness(y: np.ndarray, sr: int) -> float:
    """Rough reverb/tail presence: energy in the decaying tail after the last strong
    onset, relative to peak. Purely informational — surfaced in the manifest."""
    import librosa

    if not len(y):
        return 0.0
    rms = librosa.feature.rms(y=y)[0]
    peak = float(rms.max()) or 1.0
    # count sustained low-but-nonzero tail frames (0.02-0.2 of peak) as "wet" energy
    tail_frames = np.logical_and(rms > 0.02 * peak, rms < 0.2 * peak)
    return float(tail_frames.mean())


# ------------------------------------------------------------------- PANNs classifier

# module-level cache so the 340 MB CNN14 checkpoint loads at most once per process
_TAGGER = None
_TAGGER_FAILED = False


def _get_tagger():
    global _TAGGER, _TAGGER_FAILED
    if _TAGGER is not None or _TAGGER_FAILED:
        return _TAGGER
    try:
        from panns_inference import AudioTagging

        _TAGGER = AudioTagging(checkpoint_path=None, device="cpu")
    except Exception:
        _TAGGER_FAILED = True  # no network / no weights — router falls back to spectral cues
    return _TAGGER


def classify_instrument(y: np.ndarray, sr: int) -> tuple[str, int, float]:
    """PANNs CNN14 top instrument label -> (label, label_index, confidence).

    Returns ("unknown", -1, 0.0) if PANNs is unavailable (no network / no weights).
    Never raises. PANNs expects 32 kHz mono.
    """
    tagger = _get_tagger()
    if tagger is None or not len(y):
        return "unknown", -1, 0.0
    try:
        import librosa
        from panns_inference import labels

        wav = y if sr == 32000 else librosa.resample(y, orig_sr=sr, target_sr=32000)
        clipwise, _ = tagger.inference(wav[None, :])  # (1, 527)
        probs = np.asarray(clipwise[0])
        idx = int(np.argmax(probs))
        return labels[idx], idx, float(probs[idx])
    except Exception:
        return "unknown", -1, 0.0


def _looks_synth(label_idx: int, label: str) -> bool:
    if label_idx in _SYNTH_LABEL_IDS:
        return True
    low = label.lower()
    return any(k in low for k in _SYNTH_KEYWORDS)


def _looks_keys(label_idx: int, label: str) -> bool:
    if label_idx in _KEYS_LABEL_IDS:
        return True
    low = label.lower()
    return any(k in low for k in _KEYS_KEYWORDS)


# ------------------------------------------------------------------------- the router

def route_stem(
    stem_name: str,
    y: np.ndarray,
    sr: int,
    notes: list[dict] | None = None,
    use_panns: bool = True,
) -> StemCharacter:
    """Classify one stem's character and pick its reconstruction strategy.

    stem_name gives strong priors (drums bypass routing; bass is mono by nature).
    notes (optional) cross-checks spectral polyphony against transcribed overlap.
    use_panns=False skips the network model and relies on spectral cues alone
    (used in tests so they run offline).
    """
    notes = notes or []

    # drums are never pitch-reconstructed — always the one-shot sampler path
    if stem_name == "drums":
        return StemCharacter(
            strategy="sampler", polyphonic=False, synth_like=False, wet=False,
            instrument="drum kit", scores={},
        )

    poly_chroma = polyphony_estimate(y, sr)
    overlap = note_overlap_fraction(notes)
    sustain = sustain_ratio(y, sr)
    flat = spectral_flatness(y, sr)
    wet = wetness(y, sr)

    label, label_idx, conf = ("unknown", -1, 0.0)
    if use_panns:
        label, label_idx, conf = classify_instrument(y, sr)

    # --- polyphony: chroma concurrency is the authoritative signal (robust to
    # basic-pitch's octave/harmonic ghosts). Note overlap only escalates a *borderline*
    # chroma reading — on its own it over-fires on sustained monophonic synth tones. ---
    polyphonic = poly_chroma > _POLY_CHROMA_BINS
    if not polyphonic and poly_chroma > _POLY_CHROMA_BINS - 0.4 and overlap > _POLY_NOTE_OVERLAP:
        polyphonic = True
    # bass is monophonic by construction — don't let chroma smear route it to phrases
    if stem_name == "bass":
        polyphonic = False

    # --- synth vs acoustic: PANNs bucket first, spectral cues as fallback ---
    panns_synth = _looks_synth(label_idx, label) if label_idx >= 0 else None
    spectral_synth = sustain >= _SUSTAIN_SYNTH or flat >= _FLATNESS_SYNTH
    synth_like = panns_synth if panns_synth is not None else spectral_synth

    is_keys = _looks_keys(label_idx, label) if label_idx >= 0 else False

    # --- pick the strategy ---
    if polyphonic:
        strategy = "sampler-phrase"
    elif synth_like:
        strategy = "synth-fit"
    else:
        strategy = "sampler"

    return StemCharacter(
        strategy=strategy,
        polyphonic=polyphonic,
        synth_like=bool(synth_like),
        wet=wet > _WET_DECAY_TAIL,
        instrument=label,
        is_keys=is_keys,
        scores={
            "poly_chroma": round(poly_chroma, 3),
            "note_overlap": round(overlap, 3),
            "sustain_ratio": round(sustain, 3),
            "spectral_flatness": round(flat, 6),
            "wetness": round(wet, 3),
            "panns_confidence": round(conf, 3),
            "panns_index": label_idx,
        },
    )


def escalate_polyphony(char: StemCharacter, notes: list[dict], stem_name: str) -> StemCharacter:
    """Re-check polyphony against transcribed notes (PLAN.md's note-overlap rule) and
    re-derive the strategy if it changed. Avoids re-running the PANNs classifier — only
    the note-dependent signal is refreshed. Never downgrades a chroma-detected chord.
    """
    overlap = note_overlap_fraction(notes)
    char.scores["note_overlap"] = round(overlap, 3)
    if stem_name == "bass" or char.polyphonic:
        return char  # bass stays mono; already-polyphonic stays polyphonic
    # only escalate mono->poly when chroma was already borderline (mirrors route_stem)
    if char.scores.get("poly_chroma", 0.0) > _POLY_CHROMA_BINS - 0.4 and overlap > _POLY_NOTE_OVERLAP:
        char.polyphonic = True
        char.strategy = "sampler-phrase"
    return char
