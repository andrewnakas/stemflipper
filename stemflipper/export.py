"""Bundle export: SMF Format-1 MIDI, manifest.json, README.txt, Reaper .RPP, zip.

MVP scope per plan: the .RPP carries tempo + stem audio tracks only (plain-text
template); MIDI files sit alongside for drag-drop. Inline MIDI embedding in RPP is a
later task (see HANDOFF.md).
"""

from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

# GM programs (0-indexed) per canonical stem name
_STEM_PROGRAMS = {
    "vocals": 53,  # Voice Oohs
    "bass": 33,    # Electric Bass (finger)
    "guitar": 24,  # Nylon Guitar
    "piano": 0,    # Acoustic Grand
    "other": 48,   # String Ensemble
}

_RPP_TRACK = """\
  <TRACK
    NAME "{name}"
    <ITEM
      POSITION 0
      LENGTH {length}
      NAME "{name}"
      <SOURCE WAVE
        FILE "{file}"
      >
    >
  >
"""

_README = """\
StemFlipper export — {source}
=================================

tempo: {tempo} BPM   key: {key}   time signature: {timesig}

What's in this folder
---------------------
stems/          separated audio stems (drag into any DAW)
midi/           transcribed MIDI — song.mid is the full multitrack (Format 1,
                tempo map included); per-stem .mid files for single-track import
instruments/    sliced-sample instruments (.sfz) built from each stem — load in a
                free SFZ player (sfizz, Sforzando) or convert with DecentSampler
project.RPP     Reaper project: opens the stems arranged on tracks at the right
                tempo. Import midi/*.mid onto tracks, then drop the matching .sfz
                on an instrument track to make parts editable.
manifest.json   machine-readable metadata (tempo, key, stem->file mapping)

Honest limitations (MVP)
------------------------
- Transcription quality varies by stem; drums use an onset heuristic that misses
  overlapping hits. Treat MIDI as an editable starting point, not a perfect score.
- Sampler slices inherit any bleed/reverb baked into the separated stems.
"""


def write_midi(
    tracks: dict[str, dict], tempo: float, midi_dir: str | Path
) -> dict[str, Path]:
    """tracks: {stem_name: {"notes": [...], "is_drum": bool}} -> song.mid + per-stem mids."""
    import pretty_midi

    midi_dir = Path(midi_dir)
    midi_dir.mkdir(parents=True, exist_ok=True)
    written: dict[str, Path] = {}

    def make_pm(subset: dict[str, dict]) -> "pretty_midi.PrettyMIDI":
        pm = pretty_midi.PrettyMIDI(initial_tempo=tempo)
        for name, data in subset.items():
            inst = pretty_midi.Instrument(
                program=_STEM_PROGRAMS.get(name, 0),
                is_drum=data["is_drum"],
                name=name,
            )
            for n in data["notes"]:
                inst.notes.append(
                    pretty_midi.Note(
                        velocity=n.get("velocity", 100),
                        pitch=n["pitch"],
                        start=n["start"],
                        end=max(n["end"], n["start"] + 0.02),
                    )
                )
            pm.instruments.append(inst)
        return pm

    with_notes = {k: v for k, v in tracks.items() if v["notes"]}
    if with_notes:
        song_path = midi_dir / "song.mid"
        make_pm(with_notes).write(str(song_path))
        written["song"] = song_path
        for name, data in with_notes.items():
            p = midi_dir / f"{name}.mid"
            make_pm({name: data}).write(str(p))
            written[name] = p
    return written


def write_rpp(
    bundle_dir: str | Path,
    tempo: float,
    stems: dict[str, str],
    duration: float,
) -> Path:
    """stems: {name: bundle-relative wav path}."""
    tracks = "".join(
        _RPP_TRACK.format(name=name, length=round(duration, 3), file=rel)
        for name, rel in stems.items()
    )
    content = (
        f'<REAPER_PROJECT 0.1 "7.0" 0\n'
        f"  TEMPO {tempo} 4 4\n"
        f"{tracks}"
        f">\n"
    )
    path = Path(bundle_dir) / "project.RPP"
    path.write_text(content)
    return path


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
            timesig=analysis.time_signature,
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
