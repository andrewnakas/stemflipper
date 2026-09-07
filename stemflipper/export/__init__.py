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
                free SFZ player (sfizz, Sforzando) or convert with DecentSampler.
                Mono synth-like stems also get a .vital preset (open in Vital) — a
                best-effort editable *starting point*, not a bit-exact clone.
effects/        per-stem effect match (best-effort): <stem>.json holds an EQ curve
                (freq, gain_dB breakpoints — recreate on any DAW EQ) and, for stems
                with an audible reverb tail, an <stem>_ir.wav impulse response to load
                into a convolution reverb.
project.RPP     Reaper project: opens the stems arranged on tracks at the right
                tempo. Import midi/*.mid onto tracks, then drop the matching .sfz
                on an instrument track to make parts editable.
project.dawproject
                Open DAW-interchange project (Bitwig 5+, Studio One 6.5+, Cubase 14+):
                each stem is one track carrying BOTH its audio clip and the transcribed
                MIDI notes inline — opens arranged at tempo, ready to edit. Bundles the
                stem audio inside the .dawproject zip, so it's a single portable file.
manifest.json   machine-readable metadata (tempo, key, stem->file mapping,
                per-stem strategy/instrument/effects references)

Honest limitations (MVP)
------------------------
- Transcription quality varies by stem; drums use an onset heuristic that misses
  overlapping hits. Treat MIDI as an editable starting point, not a perfect score.
- Sampler slices inherit any bleed/reverb baked into the separated stems.
- Synth presets (.vital) and EQ/reverb matches are best-effort reconstructions:
  subtractive synthesis can't clone every timbre, and reverb/EQ are estimated blind
  from the stem. They're editable starting points — tweak to taste.
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
_DAW_COLORS = ["#e0a458", "#6ad5c0", "#8b9bff", "#e6739f", "#9ad06b", "#d0956b"]


def _xml_escape(s: str) -> str:
    return (
        s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
    )


def write_dawproject(
    tracks: dict,
    stems: dict[str, str],
    tempo: float,
    time_signature: str,
    duration: float,
    bundle_dir: str | Path,
) -> Path:
    """Author a Bitwig/Studio-One/Cubase ``.dawproject`` (open MIT format).

    Each stem becomes ONE track carrying BOTH the separated audio clip AND the
    transcribed MIDI notes embedded inline — so the project opens in a real DAW with
    the audio arranged at the right tempo and editable note data on the same track.

    We author the XML directly (stdlib ``zipfile`` + string templates), matching the
    RPP/manifest approach — no `dawproject-py` dependency (it is git-only, not on PyPI;
    same "keep CI offline, no frontier install" call as M5's dasp/syntheon decision).

    ``tracks``: {stem: {"notes": [{pitch,start,end,velocity}], "is_drum": bool}}.
    ``stems``:  {stem: bundle-relative wav path}. Times convert seconds→beats via tempo.
    """
    bundle_dir = Path(bundle_dir)
    bps = tempo / 60.0  # beats per second
    try:
        num, den = (int(x) for x in str(time_signature).split("/"))
    except Exception:
        num, den = 4, 4

    _id = [0]

    def nid() -> str:
        _id[0] += 1
        return f"id{_id[0]}"

    structure, arrangement = [], []
    for i, (name, rel_wav) in enumerate(stems.items()):
        color = _DAW_COLORS[i % len(_DAW_COLORS)]
        track_id = nid()
        structure.append(
            f'    <Track contentType="audio notes" id="{track_id}" '
            f'name="{_xml_escape(name)}" color="{color}" loaded="true">\n'
            f'      <Channel role="regular" audioChannels="2" id="{nid()}"/>\n'
            f"    </Track>"
        )

        dur_beats = round(duration * bps, 6)
        audio_file = f"audio/{Path(rel_wav).name}"
        clips = [
            f'        <Clip time="0.0" duration="{dur_beats}">\n'
            f'          <Warps timeUnit="beats" contentTimeUnit="seconds">\n'
            f'            <Audio channels="2" duration="{round(duration, 6)}" algorithm="stretch">\n'
            f'              <File path="{_xml_escape(audio_file)}"/>\n'
            f"            </Audio>\n"
            f'            <Warp time="0.0" contentTime="0.0"/>\n'
            f'            <Warp time="{dur_beats}" contentTime="{round(duration, 6)}"/>\n'
            f"          </Warps>\n"
            f"        </Clip>"
        ]

        notes = (tracks.get(name) or {}).get("notes") or []
        if notes:
            note_xml = "".join(
                f'            <Note time="{round(n["start"] * bps, 6)}" '
                f'duration="{round((n["end"] - n["start"]) * bps, 6)}" '
                f'channel="{9 if tracks[name].get("is_drum") else 0}" '
                f'key="{int(n["pitch"])}" '
                f'vel="{round(min(127, max(0, int(n.get("velocity", 100)))) / 127.0, 6)}"/>\n'
                for n in notes
            )
            clips.append(
                f'        <Clip time="0.0" duration="{dur_beats}">\n'
                f'          <Notes id="{nid()}">\n{note_xml}'
                f"          </Notes>\n"
                f"        </Clip>"
            )

        arrangement.append(
            f'      <Lanes track="{track_id}" id="{nid()}">\n'
            f'        <Clips id="{nid()}">\n' + "\n".join(clips) + "\n"
            f"        </Clips>\n"
            f"      </Lanes>"
        )

    project_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Project version="1.0">\n'
        '  <Application name="StemFlipper" version="0.1.0"/>\n'
        "  <Transport>\n"
        f'    <Tempo value="{tempo}" unit="bpm" id="{nid()}"/>\n'
        f'    <TimeSignature numerator="{num}" denominator="{den}" id="{nid()}"/>\n'
        "  </Transport>\n"
        f'  <Structure>\n' + "\n".join(structure) + "\n  </Structure>\n"
        f'  <Arrangement id="{nid()}">\n'
        f'    <Lanes timeUnit="beats" id="{nid()}">\n' + "\n".join(arrangement) + "\n"
        "    </Lanes>\n"
        "  </Arrangement>\n"
        "</Project>\n"
    )
    metadata_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        "<MetaData>\n"
        "  <Title>StemFlipper export</Title>\n"
        "  <Software>StemFlipper 0.1.0</Software>\n"
        "</MetaData>\n"
    )

    path = bundle_dir / "project.dawproject"
    import zipfile

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("project.xml", project_xml)
        zf.writestr("metadata.xml", metadata_xml)
        for rel_wav in stems.values():
            wav_path = bundle_dir / rel_wav
            if wav_path.exists():
                zf.write(wav_path, f"audio/{Path(rel_wav).name}")
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
