"""DAWproject export — one editable project with audio + embedded MIDI per stem.

Open interchange format (MIT): Bitwig 5+, Studio One 6.5+, Cubase 14+. XML is authored
directly with stdlib zipfile because dawproject-py is git-only (offline-CI rule).
"""

from __future__ import annotations

import shutil
import zipfile
from pathlib import Path

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
