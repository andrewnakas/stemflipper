"""Deterministic synthetic mini-song with ground-truth MIDI, for tests.

Renders 16 s at 120 BPM / 44.1 kHz: drums (synthesized kick/snare/hat),
bass (band-limited saw, A-minor riff), lead (saw melody). No randomness
outside a fixed-seed noise template, so output is bit-identical across runs.

Outputs into a target directory:
    mix.wav  stem_drums.wav  stem_bass.wav  stem_lead.wav
    ground_truth.json  ground_truth.mid

Usage: python tests/make_fixture.py <outdir>
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import butter, sosfilt

SR = 44100
TEMPO = 120.0
BEAT = 60.0 / TEMPO  # 0.5 s
BARS = 8
DURATION = BARS * 4 * BEAT  # 16.0 s

GM_KICK, GM_SNARE, GM_HAT = 36, 38, 42

# One fixed noise template shared by snare/hat so the render is deterministic.
_NOISE = np.random.RandomState(1234).randn(int(0.3 * SR))


def midi_to_hz(m: float) -> float:
    return 440.0 * 2.0 ** ((m - 69) / 12)


def _env(n: int, attack_s: float, release_s: float) -> np.ndarray:
    """Linear attack, sustain at 1, linear release."""
    env = np.ones(n)
    a = max(1, int(attack_s * SR))
    r = max(1, int(release_s * SR))
    env[:a] = np.linspace(0.0, 1.0, a)
    env[-r:] *= np.linspace(1.0, 0.0, r)
    return env


def saw_note(freq: float, dur_s: float, gain: float = 1.0) -> np.ndarray:
    """Band-limited sawtooth: summed harmonics below SR/4."""
    n = int(dur_s * SR)
    t = np.arange(n) / SR
    out = np.zeros(n)
    k = 1
    while freq * k < SR / 4:
        out += np.sin(2 * np.pi * freq * k * t) / k
        k += 1
    out *= _env(n, 0.005, 0.03) * gain / 1.6
    return out


def kick_hit() -> np.ndarray:
    n = int(0.35 * SR)
    t = np.arange(n) / SR
    freq = 50 + 100 * np.exp(-t * 25)  # 150 Hz -> 50 Hz sweep
    phase = 2 * np.pi * np.cumsum(freq) / SR
    return np.sin(phase) * np.exp(-t * 18)


def snare_hit() -> np.ndarray:
    n = int(0.25 * SR)
    t = np.arange(n) / SR
    sos = butter(2, [180, 6000], btype="band", fs=SR, output="sos")
    noise = sosfilt(sos, _NOISE[:n])
    tone = 0.5 * np.sin(2 * np.pi * 190 * t)
    return (noise / max(1e-9, np.abs(noise).max()) + tone) * np.exp(-t * 22) * 0.8


def hat_hit() -> np.ndarray:
    n = int(0.08 * SR)
    t = np.arange(n) / SR
    sos = butter(2, 7000, btype="high", fs=SR, output="sos")
    noise = sosfilt(sos, _NOISE[:n])
    return noise / max(1e-9, np.abs(noise).max()) * np.exp(-t * 60) * 0.6


def _place(track: np.ndarray, hit: np.ndarray, at_s: float) -> None:
    i = int(at_s * SR)
    j = min(len(track), i + len(hit))
    track[i:j] += hit[: j - i]


def build_fixture(outdir: Path) -> dict:
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    n_total = int(DURATION * SR)

    # ---- note data (ground truth) -------------------------------------
    drum_notes, bass_notes, lead_notes = [], [], []

    drums = np.zeros(n_total)
    for bar in range(BARS):
        t0 = bar * 4 * BEAT
        for b in (0, 2):  # kick beats 1 & 3
            _place(drums, kick_hit(), t0 + b * BEAT)
            drum_notes.append((GM_KICK, t0 + b * BEAT))
        for b in (1, 3):  # snare beats 2 & 4
            _place(drums, snare_hit(), t0 + b * BEAT)
            drum_notes.append((GM_SNARE, t0 + b * BEAT))
        for e in range(8):  # closed hats on 8ths
            _place(drums, hat_hit(), t0 + e * BEAT / 2)
            drum_notes.append((GM_HAT, t0 + e * BEAT / 2))

    # bass riff per bar: A1 . C2 D2 (MIDI 33, 36, 38)
    bass_riff = [(33, 0.0, 0.9), (36, 1.0, 0.4), (38, 1.5, 0.4)]
    bass = np.zeros(n_total)
    for bar in range(BARS):
        t0 = bar * 4 * BEAT
        for pitch, off, dur in bass_riff:
            _place(bass, saw_note(midi_to_hz(pitch), dur), t0 + off)
            bass_notes.append((pitch, t0 + off, t0 + off + dur))

    # lead: two-bar phrase of quarter notes, repeated (A4 C5 E5 G5 | E5 C5 B4 A4)
    lead_phrase = [69, 72, 76, 79, 76, 72, 71, 69]
    lead = np.zeros(n_total)
    for phrase in range(BARS // 2):
        t0 = phrase * 8 * BEAT
        for i, pitch in enumerate(lead_phrase):
            start = t0 + i * BEAT
            _place(lead, saw_note(midi_to_hz(pitch), 0.45, gain=0.6), start)
            lead_notes.append((pitch, start, start + 0.45))

    stems = {"drums": drums * 0.9, "bass": bass * 0.9, "lead": lead * 0.9}
    mix = sum(stems.values())
    mix = mix / np.abs(mix).max() * 0.89

    paths = {"mix": outdir / "mix.wav"}
    sf.write(paths["mix"], mix, SR)
    for name, audio in stems.items():
        paths[name] = outdir / f"stem_{name}.wav"
        sf.write(paths[name], audio, SR)

    truth = {
        "sr": SR,
        "tempo": TEMPO,
        "duration": DURATION,
        "tracks": {
            "drums": [{"pitch": p, "start": s, "end": s + 0.1} for p, s in drum_notes],
            "bass": [{"pitch": p, "start": s, "end": e} for p, s, e in bass_notes],
            "lead": [{"pitch": p, "start": s, "end": e} for p, s, e in lead_notes],
        },
    }
    (outdir / "ground_truth.json").write_text(json.dumps(truth, indent=1))

    import pretty_midi

    pm = pretty_midi.PrettyMIDI(initial_tempo=TEMPO)
    inst_map = [("drums", 0, True), ("bass", 33, False), ("lead", 81, False)]
    for name, program, is_drum in inst_map:
        inst = pretty_midi.Instrument(program=program, is_drum=is_drum, name=name)
        for note in truth["tracks"][name]:
            inst.notes.append(
                pretty_midi.Note(
                    velocity=100, pitch=note["pitch"],
                    start=note["start"], end=note["end"],
                )
            )
        pm.instruments.append(inst)
    pm.write(str(outdir / "ground_truth.mid"))

    return {"dir": outdir, "paths": paths, "truth": truth}


if __name__ == "__main__":
    out = build_fixture(Path(sys.argv[1] if len(sys.argv) > 1 else "tests/assets"))
    print(f"fixture written to {out['dir']}")
