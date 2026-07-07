"""Sliced-sample instrument builder: transcribed MIDI boundaries -> wav slices + SFZ.

SFZ is plain text — generated with string templates on purpose (pysfz is abandoned;
see PLAN.md §4). One representative slice per distinct pitch, regions cover the full
key range via midpoints, single velocity layer. Loadable in sfizz / DecentSampler /
Sforzando.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import soundfile as sf

_MIN_SLICE_S = 0.03
_RELEASE_PAD_S = 0.05

_SFZ_HEADER = """\
// StemFlipper sliced instrument: {stem}
// Generated from transcribed note boundaries; load in sfizz, Sforzando or DecentSampler.
<control>
default_path=samples/

<global>
ampeg_release=0.4
{global_extra}
"""

_SFZ_REGION = (
    "<region> sample={sample} lokey={lokey} hikey={hikey} "
    "pitch_keycenter={center}{extra}\n"
)


def build_sampler(
    stem_name: str,
    audio_path: str | Path,
    notes: list[dict],
    out_dir: str | Path,
    is_drum: bool = False,
) -> dict | None:
    """Write instruments/<stem>/{<stem>.sfz, samples/*.wav}; return metadata or None."""
    if not notes:
        return None
    y, sr = sf.read(str(audio_path))
    if y.ndim > 1:
        y = y.mean(axis=1)

    picked = _pick_representatives(notes, is_drum)
    out_dir = Path(out_dir)
    samples_dir = out_dir / "samples"
    samples_dir.mkdir(parents=True, exist_ok=True)

    regions = []
    for pitch, note in sorted(picked.items()):
        start = int(note["start"] * sr)
        end = int((note["end"] + _RELEASE_PAD_S) * sr)
        seg = y[start : min(end, len(y))]
        if len(seg) < int(_MIN_SLICE_S * sr):
            continue
        sample_name = f"{stem_name}_{pitch:03d}.wav"
        sf.write(str(samples_dir / sample_name), seg, sr)
        regions.append((pitch, sample_name))
    if not regions:
        return None

    sfz_path = out_dir / f"{stem_name}.sfz"
    sfz_path.write_text(_render_sfz(stem_name, regions, is_drum))
    return {
        "sfz": sfz_path,
        "samples_dir": samples_dir,
        "n_regions": len(regions),
    }


def _pick_representatives(notes: list[dict], is_drum: bool) -> dict[int, dict]:
    """One note per distinct pitch: loudest for drums, longest for pitched."""
    best: dict[int, dict] = {}
    for n in notes:
        cur = best.get(n["pitch"])
        if cur is None:
            best[n["pitch"]] = n
        elif is_drum and n["velocity"] > cur["velocity"]:
            best[n["pitch"]] = n
        elif not is_drum and (n["end"] - n["start"]) > (cur["end"] - cur["start"]):
            best[n["pitch"]] = n
    return best


def _render_sfz(stem_name: str, regions: list[tuple[int, str]], is_drum: bool) -> str:
    global_extra = "loop_mode=one_shot" if is_drum else ""
    out = _SFZ_HEADER.format(stem=stem_name, global_extra=global_extra)
    pitches = [p for p, _ in regions]
    for i, (pitch, sample) in enumerate(regions):
        if is_drum:
            lokey = hikey = pitch
        else:
            # midpoints to neighbors; outermost regions cover the full keyboard
            lokey = 0 if i == 0 else (pitches[i - 1] + pitch) // 2 + 1
            hikey = 127 if i == len(regions) - 1 else (pitch + pitches[i + 1]) // 2
        out += _SFZ_REGION.format(
            sample=sample, lokey=lokey, hikey=hikey, center=pitch, extra=""
        )
    return out
