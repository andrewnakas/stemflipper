"""MIDI export: multitrack SMF-1 with a real tempo map, markers and a chord track.

v1 wrote a single initial tempo and put note times in seconds through pretty_midi, so a
song that drifts (any live take) landed progressively off the grid in a DAW. Positions
are now converted through the grid's piecewise seconds<->beats map, and the tempo map is
written as real tempo events.
"""

from __future__ import annotations

import logging
from pathlib import Path

log = logging.getLogger(__name__)

TICKS_PER_BEAT = 480

#: General MIDI program per stem (drums bypass to channel 10)
STEM_PROGRAMS = {
    "vocals": 53,   # Voice Oohs
    "bass": 33,     # Electric Bass (finger)
    "guitar": 24,   # Acoustic Guitar (nylon)
    "piano": 0,     # Acoustic Grand
    "other": 48,    # String Ensemble
}
DRUM_CHANNEL = 9  # zero-based: MIDI channel 10


def _mido():
    import mido

    return mido


def _beats(grid, seconds: float) -> float:
    if grid is None:
        return seconds * 2.0
    return grid.seconds_to_beats(seconds)


def _ticks(beats: float) -> int:
    return max(0, int(round(beats * TICKS_PER_BEAT)))


def _tempo_track(mido, grid, sections: list[dict] | None = None):
    track = mido.MidiTrack()
    ts = (getattr(grid, "time_signature", "4/4") or "4/4").split("/")
    try:
        numerator, denominator = int(ts[0]), int(ts[1])
    except Exception:
        numerator, denominator = 4, 4
    track.append(mido.MetaMessage("time_signature", numerator=numerator,
                                  denominator=denominator, time=0))

    events: list[tuple[int, object]] = []
    tempo_map = list(getattr(grid, "tempo_map", None) or [[0.0, getattr(grid, "tempo", 120.0)]])
    for seconds, bpm in tempo_map:
        events.append((
            _ticks(_beats(grid, float(seconds))),
            mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(float(bpm)), time=0),
        ))
    for s in sections or []:
        events.append((
            _ticks(_beats(grid, float(s["start"]))),
            mido.MetaMessage("marker", text=str(s.get("label", "section")), time=0),
        ))

    events.sort(key=lambda e: e[0])
    last = 0
    for tick, msg in events:
        msg.time = max(0, tick - last)
        last = tick
        track.append(msg)
    track.append(mido.MetaMessage("end_of_track", time=0))
    return track


def _note_track(mido, name: str, notes: list[dict], grid, is_drum: bool, program: int):
    track = mido.MidiTrack()
    track.append(mido.MetaMessage("track_name", name=name, time=0))
    channel = DRUM_CHANNEL if is_drum else 0
    if not is_drum:
        track.append(mido.Message("program_change", program=program, channel=channel, time=0))

    events: list[tuple[int, int, object]] = []
    for n in notes or []:
        start = _ticks(_beats(grid, float(n["start"])))
        end = max(start + 1, _ticks(_beats(grid, float(n["end"]))))
        pitch = int(max(0, min(127, n["pitch"])))
        vel = int(max(1, min(127, n.get("velocity", 90))))
        events.append((start, 1, mido.Message("note_on", note=pitch, velocity=vel, channel=channel, time=0)))
        events.append((end, 0, mido.Message("note_off", note=pitch, velocity=0, channel=channel, time=0)))

    events.sort(key=lambda e: (e[0], e[1]))
    last = 0
    for tick, _, msg in events:
        msg.time = max(0, tick - last)
        last = tick
        track.append(msg)
    track.append(mido.MetaMessage("end_of_track", time=0))
    return track


_CHORD_INTERVALS = {
    "maj": (0, 4, 7), "min": (0, 3, 7), "dom7": (0, 4, 7, 10),
    "min7": (0, 3, 7, 10), "maj7": (0, 4, 7, 11), "power": (0, 7),
}


def _chord_track(mido, chords: list[dict], grid):
    track = mido.MidiTrack()
    track.append(mido.MetaMessage("track_name", name="Chords", time=0))
    track.append(mido.Message("program_change", program=4, channel=1, time=0))
    events = []
    for c in chords or []:
        root = c.get("root")
        if root is None:
            continue
        base = 48 + int(root)  # C3 register
        start = _ticks(_beats(grid, float(c["start"])))
        end = max(start + 1, _ticks(_beats(grid, float(c["end"]))))
        for interval in _CHORD_INTERVALS.get(c.get("quality", "maj"), (0, 4, 7)):
            pitch = base + interval
            events.append((start, 1, mido.Message("note_on", note=pitch, velocity=70, channel=1, time=0)))
            events.append((end, 0, mido.Message("note_off", note=pitch, velocity=0, channel=1, time=0)))
    events.sort(key=lambda e: (e[0], e[1]))
    last = 0
    for tick, _, msg in events:
        msg.time = max(0, tick - last)
        last = tick
        track.append(msg)
    track.append(mido.MetaMessage("end_of_track", time=0))
    return track


def write_midi(
    tracks: dict[str, dict],
    grid,
    midi_dir: str | Path,
    chords: list[dict] | None = None,
    sections: list[dict] | None = None,
) -> dict[str, Path]:
    """Write midi/song.mid (+ per-stem .mid, + chords.mid). Returns {name: path}."""
    mido = _mido()
    midi_dir = Path(midi_dir)
    midi_dir.mkdir(parents=True, exist_ok=True)
    written: dict[str, Path] = {}

    with_notes = {n: t for n, t in tracks.items() if t.get("notes")}
    if not with_notes:
        return written

    song = mido.MidiFile(type=1, ticks_per_beat=TICKS_PER_BEAT)
    song.tracks.append(_tempo_track(mido, grid, sections))
    for name, t in with_notes.items():
        song.tracks.append(_note_track(
            mido, name, t["notes"], grid, t.get("is_drum", False),
            STEM_PROGRAMS.get(name, 0),
        ))
    if chords:
        song.tracks.append(_chord_track(mido, chords, grid))
    song_path = midi_dir / "song.mid"
    song.save(str(song_path))
    written["song"] = song_path

    for name, t in with_notes.items():
        single = mido.MidiFile(type=1, ticks_per_beat=TICKS_PER_BEAT)
        single.tracks.append(_tempo_track(mido, grid, sections))
        single.tracks.append(_note_track(
            mido, name, t["notes"], grid, t.get("is_drum", False),
            STEM_PROGRAMS.get(name, 0),
        ))
        path = midi_dir / f"{name}.mid"
        single.save(str(path))
        written[name] = path

    if chords:
        cm = mido.MidiFile(type=1, ticks_per_beat=TICKS_PER_BEAT)
        cm.tracks.append(_tempo_track(mido, grid, sections))
        cm.tracks.append(_chord_track(mido, chords, grid))
        path = midi_dir / "chords.mid"
        cm.save(str(path))
        written["chords"] = path
    return written
