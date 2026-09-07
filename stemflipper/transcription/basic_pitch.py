"""basic-pitch (Apache-2.0) — the generalist pitched transcriber.

v1 called it with stock thresholds for every stem. Each instrument family wants different
sensitivity and a different frequency window, so the thresholds are now a per-stem table.
The bass clamp in particular kills basic-pitch's #1 failure mode: octave errors.
"""

from __future__ import annotations

import logging
from pathlib import Path

log = logging.getLogger(__name__)

#: kwargs passed to basic_pitch.inference.predict, per stem.
#: minimum_note_length is in MILLISECONDS.
THRESHOLDS: dict[str, dict] = {
    "bass": dict(
        onset_threshold=0.6, frame_threshold=0.4, minimum_note_length=80,
        minimum_frequency=30.0, maximum_frequency=350.0,
    ),
    "vocals": dict(
        onset_threshold=0.5, frame_threshold=0.3, minimum_note_length=70,
        minimum_frequency=60.0, maximum_frequency=1500.0,
    ),
    "guitar": dict(
        onset_threshold=0.5, frame_threshold=0.3, minimum_note_length=60,
        minimum_frequency=70.0, maximum_frequency=1400.0,
    ),
    "piano": dict(
        onset_threshold=0.5, frame_threshold=0.3, minimum_note_length=58,
        minimum_frequency=27.5, maximum_frequency=4200.0,
    ),
    "other": dict(onset_threshold=0.5, frame_threshold=0.3, minimum_note_length=58),
}


def _onnx_model_path():
    """The basic-pitch ICASSP-2022 model in ONNX form, or None if unavailable.

    We FORCE the ONNX backend rather than let basic-pitch auto-pick. Its default
    priority is tf > coreml > tflite > onnx, and on Linux (the Space) `tflite-runtime`
    is pulled in as a transitive dep of basic-pitch — but tflite-runtime's wheels are
    compiled against numpy 1.x and hard-crash under numpy 2.x (`_ARRAY_API not found`),
    which silently zeroed every pitched stem (drums survived because they don't use
    basic-pitch). onnxruntime is numpy-2 clean. Passing the .onnx path explicitly
    sidesteps the whole backend-priority problem. Adding `onnxruntime` to requirements
    was necessary but NOT sufficient — tflite still won the priority race.
    """
    try:
        from basic_pitch import FilenameSuffix, build_icassp_2022_model_path

        return build_icassp_2022_model_path(FilenameSuffix.onnx)
    except Exception:
        return None


def transcribe_pitched(audio_path: str | Path, stem_name: str = "other", **overrides) -> list[dict]:
    """Notes for one pitched stem, using that stem's tuned thresholds."""
    from basic_pitch.inference import predict

    params = dict(THRESHOLDS.get(stem_name, THRESHOLDS["other"]))
    params.update({k: v for k, v in overrides.items() if v is not None})

    model = _onnx_model_path()
    kwargs = dict(params)
    if model is not None:
        kwargs["model_or_model_path"] = model
    _, midi_data, _ = predict(str(audio_path), **kwargs)

    notes = []
    for instrument in midi_data.instruments:
        for n in instrument.notes:
            notes.append({
                "pitch": int(n.pitch),
                "start": round(float(n.start), 4),
                "end": round(float(n.end), 4),
                "velocity": int(n.velocity),
                # basic-pitch does not expose per-note probabilities through predict();
                # longer notes survive its frame threshold more reliably, so length is
                # the only honest confidence proxy available here.
                "confidence": round(min(0.95, 0.5 + 0.5 * min(float(n.end - n.start), 0.5) / 0.5), 3),
            })
    return sorted(notes, key=lambda n: (n["start"], n["pitch"]))
