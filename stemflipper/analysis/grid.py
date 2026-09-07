"""The musical grid: tempo, beats, downbeats, time signature, tempo map.

v1 had a flat beat list and a hardcoded "4/4" string. The browser draws bars, the loop
extractor cuts at downbeats and the MIDI writer needs a tempo map, so the grid is now a
first-class object with a seconds<->beats mapping that follows real tempo drift instead
of assuming a constant BPM.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

_MIN_BPM, _MAX_BPM = 40.0, 220.0


@dataclass
class Grid:
    tempo: float
    beats: list[float] = field(default_factory=list)
    downbeats: list[float] = field(default_factory=list)
    time_signature: str = "4/4"
    tempo_map: list[list[float]] = field(default_factory=list)
    source: str = "librosa"

    @property
    def beats_per_bar(self) -> int:
        try:
            return max(1, int(self.time_signature.split("/")[0]))
        except Exception:
            return 4

    def seconds_to_beats(self, t: float) -> float:
        return seconds_to_beats(t, self.beats, self.tempo)

    def beats_to_seconds(self, b: float) -> float:
        return beats_to_seconds(b, self.beats, self.tempo)

    def to_dict(self) -> dict:
        from ..export.project_json import grid_entry

        return grid_entry(
            self.tempo,
            self.beats,
            downbeats=self.downbeats,
            time_signature=self.time_signature,
            tempo_map=self.tempo_map,
            source=self.source,
        )


def median_bpm(beats) -> float:
    """Tempo from beat spacing, octave-clamped into a musical range."""
    beats = np.asarray(beats, dtype=float)
    if len(beats) < 2:
        return 120.0
    intervals = np.diff(beats)
    intervals = intervals[intervals > 1e-3]
    if not len(intervals):
        return 120.0
    bpm = 60.0 / float(np.median(intervals))
    while bpm and bpm < _MIN_BPM:
        bpm *= 2
    while bpm > _MAX_BPM:
        bpm /= 2
    return float(bpm)


def infer_time_signature(beats, downbeats) -> str:
    """Beats per bar = the modal gap between downbeats, in beats.

    Guards the two ways this goes wrong in practice: too few downbeats to be meaningful,
    and a tracker that marks (nearly) every beat as a downbeat on ambiguous material —
    both fall back to 4/4 rather than inventing a 1/4 or 17/4 signature.
    """
    beats = np.asarray(beats, dtype=float)
    downbeats = np.asarray(downbeats, dtype=float)
    if len(downbeats) < 3 or len(beats) < 4:
        return "4/4"
    # a downbeat on (almost) every beat carries no bar information
    if len(downbeats) > 0.8 * len(beats):
        return "4/4"

    counts = []
    for a, b in zip(downbeats[:-1], downbeats[1:]):
        n = int(np.sum((beats >= a - 1e-3) & (beats < b - 1e-3)))
        if 1 <= n <= 12:
            counts.append(n)
    if not counts:
        return "4/4"
    values, freq = np.unique(counts, return_counts=True)
    best = int(values[int(np.argmax(freq))])
    # only trust a signature the majority of bars agree on
    if freq.max() < 0.5 * len(counts):
        return "4/4"
    return f"{best}/4" if best in (2, 3, 4, 5, 6, 7, 9, 12) else "4/4"


def tempo_map_from_beats(beats, max_points: int = 64) -> list[list[float]]:
    """[[seconds, bpm], ...] breakpoints tracking real tempo drift.

    A new breakpoint is emitted only when the local tempo moves more than 1.5 %, so a
    steady song yields a single point and a live/rubato take yields a real curve.
    """
    beats = np.asarray(beats, dtype=float)
    if len(beats) < 3:
        return [[0.0, round(median_bpm(beats), 3)]]
    intervals = np.diff(beats)
    # 4-beat rolling median smooths tracker jitter without erasing genuine drift
    win = min(4, len(intervals))
    smooth = np.array(
        [np.median(intervals[max(0, i - win + 1) : i + 1]) for i in range(len(intervals))]
    )
    bpms = 60.0 / np.clip(smooth, 1e-3, None)
    points: list[list[float]] = [[0.0, float(bpms[0])]]
    for t, bpm in zip(beats[:-1], bpms):
        if abs(bpm - points[-1][1]) / max(points[-1][1], 1e-6) > 0.015:
            points.append([float(t), float(bpm)])
    if len(points) > max_points:  # keep it compact for the JSON contract
        idx = np.linspace(0, len(points) - 1, max_points).astype(int)
        points = [points[i] for i in sorted(set(idx.tolist()))]
    return [[round(t, 4), round(b, 3)] for t, b in points]


def seconds_to_beats(t: float, beats, tempo: float) -> float:
    """Musical position of a time, interpolating between tracked beats.

    Outside the tracked range it extrapolates at the local tempo, so notes before the
    first beat or after the last still land at sensible bar positions in exported MIDI.
    """
    beats = np.asarray(beats, dtype=float)
    if len(beats) < 2:
        return float(t) * float(tempo) / 60.0
    if t <= beats[0]:
        step = beats[1] - beats[0]
        return float((t - beats[0]) / step) if step > 0 else 0.0
    if t >= beats[-1]:
        step = beats[-1] - beats[-2]
        return float(len(beats) - 1 + (t - beats[-1]) / step) if step > 0 else float(len(beats) - 1)
    i = int(np.searchsorted(beats, t) - 1)
    span = beats[i + 1] - beats[i]
    return float(i + (t - beats[i]) / span) if span > 0 else float(i)


def beats_to_seconds(b: float, beats, tempo: float) -> float:
    beats = np.asarray(beats, dtype=float)
    if len(beats) < 2:
        return float(b) * 60.0 / float(tempo)
    if b <= 0:
        step = beats[1] - beats[0]
        return float(beats[0] + b * step)
    if b >= len(beats) - 1:
        step = beats[-1] - beats[-2]
        return float(beats[-1] + (b - (len(beats) - 1)) * step)
    i = int(np.floor(b))
    frac = b - i
    return float(beats[i] + frac * (beats[i + 1] - beats[i]))


def build_grid(
    beats,
    downbeats=None,
    duration: float | None = None,
    fallback_tempo: float | None = None,
    source: str = "librosa",
) -> Grid:
    beats = [float(b) for b in (beats or [])]
    downbeats = [float(b) for b in (downbeats or [])]
    tempo = median_bpm(beats) if len(beats) >= 2 else float(fallback_tempo or 120.0)
    return Grid(
        tempo=round(tempo, 2),
        beats=beats,
        downbeats=downbeats,
        time_signature=infer_time_signature(beats, downbeats),
        tempo_map=tempo_map_from_beats(beats),
        source=source,
    )
