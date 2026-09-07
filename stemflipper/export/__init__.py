"""Bundle export.

v2 emits MIDI (tempo map + chord track + section markers), sample-based instruments,
loops, phrases, project.json and a DAWproject. The Reaper .RPP is GONE: it carried only a
tempo and audio-file references, and every DAW opens the MIDI + DAWproject instead.
"""

from __future__ import annotations

from .bundle import cleanup_workdirs, stems_to_flac  # noqa: F401
from .dawproject import write_dawproject  # noqa: F401
from .midi import STEM_PROGRAMS, write_midi  # noqa: F401
from .project_json import (  # noqa: F401
    build_project, grid_entry, stage, track_entry, validate_project, write_project,
)

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

# GM programs (0-indexed) per canonical stem name
_README = """\
StemFlipper bundle — {source}
tempo {tempo} BPM · key {key} · {timesig} · {duration:.0f}s

WHAT'S IN HERE

  project.json          everything below, described: grid, chords, per-track notes,
                        which engine transcribed what, and where every asset lives.
                        Open the web app and point it at this bundle to mix and edit.
  stems/*.flac          separated stems (24-bit). stems/drums/ holds the kit split into
                        kick, snare, toms, hi-hat, ride and crash where available.
  midi/song.mid         multitrack MIDI with a real tempo map, time signature, section
                        markers and a chord track. midi/<stem>.mid is one stem alone.
  instruments/<stem>/   a playable instrument built from THIS song's audio:
                          instrument.json / kit.json   the web app's sampler
                          *.sfz                        sfizz, Sforzando, DecentSampler
                          *.dspreset                   DecentSampler (free, all platforms)
                          *.vital                      Vital synth patch (synth-like stems)
                          samples/                     the extracted one-shots / multisamples
  loops/*.wav           bar-aligned loops cut at real downbeats, named with tempo and key.
  phrases/*.wav         silence-bounded phrase chops (mostly vocals), labelled by range.
  effects/*.json        measured EQ curve and reverb time per stem (+ an impulse response).
  project.dawproject    open project format: Bitwig 5+, Studio One 6.5+, Cubase 14+.

HOW TO USE IT

  Any DAW:        drag midi/song.mid in, then drag the stems onto audio tracks.
  Bitwig/S1/Cubase: open project.dawproject — tracks, audio and MIDI arrive together.
  Samplers:       load instruments/<stem>/<stem>.sfz (sfizz) or .dspreset (DecentSampler).
  Browser:        the StemFlipper web app plays the original stems alongside the
                  synthesised and sampled reconstructions, and lets you edit the notes.

HONEST LIMITATIONS

  Transcription is an editable starting point, not a finished score. Drums are the most
  accurate part (each kit piece is separated and transcribed on its own); dense polyphony
  in `other` is the least. Samples inherit whatever bleed and reverb the separation left
  in the stem. The Vital patch and the EQ/reverb match are approximations of the sound,
  not a recreation of the original chain.

  Separation weights are trained on MUSDB18 (non-commercial training data), so this is a
  research/educational tool, not a commercial service.
"""


def write_notes(
    tracks: dict,
    duration: float,
    bundle_dir: str | Path,
    tempo: float | None = None,
    beat_times: list | None = None,
    time_signature: str = "4/4",
) -> Path:
    """Per-stem detected notes → notes.json, for UI piano-rolls (and the download).

    tracks: {stem_name: {"notes": [{pitch,start,end,velocity}], "is_drum": bool}}.
    Each stem's notes are stored as compact ``[pitch, start, end, velocity]`` rows
    (ints/rounded floats) so the file stays small and a client can draw them without
    parsing MIDI. ``duration`` bounds the time axis. Stems with no notes are omitted.

    ``tempo``/``beat_times``/``time_signature`` (optional) let the client draw a real
    bar/beat grid instead of arbitrary divisions — the roll reads like a DAW timeline.
    ``beat_times`` is stored as rounded seconds; a large grid is downsampled to beats.
    """
    stems = {}
    for name, data in tracks.items():
        notes = data.get("notes") or []
        if not notes:
            continue
        stems[name] = {
            "is_drum": bool(data.get("is_drum")),
            "notes": [
                [int(n["pitch"]), round(float(n["start"]), 4),
                 round(float(n["end"]), 4), int(n.get("velocity", 100))]
                for n in notes
            ],
        }
    payload = {"duration": round(float(duration), 3), "stems": stems}
    if tempo:
        payload["tempo"] = round(float(tempo), 2)
    if beat_times:
        payload["beats"] = [round(float(b), 4) for b in beat_times]
    payload["time_signature"] = time_signature
    path = Path(bundle_dir) / "notes.json"
    path.write_text(json.dumps(payload))
    return path


# Track colors (cycled) for the DAWproject arrangement.
def write_manifest(bundle_dir: str | Path, meta: dict) -> Path:
    path = Path(bundle_dir) / "manifest.json"
    path.write_text(json.dumps(meta, indent=2))
    return path


def write_readme(bundle_dir: str | Path, source: str, analysis) -> Path:
    path = Path(bundle_dir) / "README.txt"
    path.write_text(
        _README.format(
            source=source,
            tempo=analysis.tempo,
            key=analysis.key,
            duration=float(getattr(analysis, "duration", 0.0) or 0.0),
            timesig=getattr(analysis, "time_signature", "4/4"),
        )
    )
    return path


def make_manifest_meta(source: str, analysis, model: str, stems_meta: dict) -> dict:
    return {
        "app": "stemflipper",
        "version": "0.1.0",
        "created_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source_file": source,
        "separation_model": model,
        "tempo": analysis.tempo,
        "key": analysis.key,
        "time_signature": analysis.time_signature,
        "duration": round(analysis.duration, 3),
        "sample_rate": analysis.sr,
        "stems": stems_meta,
    }


def zip_bundle(bundle_dir: str | Path) -> Path:
    bundle_dir = Path(bundle_dir)
    zip_path = shutil.make_archive(str(bundle_dir), "zip", root_dir=bundle_dir.parent, base_dir=bundle_dir.name)
    return Path(zip_path)
