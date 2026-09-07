"""SFZ writer — velocity layers, round robins, loop points, envelopes.

Plain text on purpose (pysfz is abandoned). Loads in sfizz, Sforzando and DecentSampler.
v1 emitted one region per pitch with a single velocity layer and no envelope beyond a
fixed release; this writes what the sample set actually contains.
"""

from __future__ import annotations

from pathlib import Path

_HEADER = """\
// StemFlipper instrument: {name}
// Generated from transcribed note boundaries. Load in sfizz, Sforzando or DecentSampler.
<control>
default_path=samples/

<global>
ampeg_attack={a:.4f}
ampeg_decay={d:.4f}
ampeg_sustain={s:.1f}
ampeg_release={r:.4f}
"""


def _env(instrument: dict) -> dict:
    env = dict(instrument.get("amp_env") or {})
    return {
        "a": float(env.get("a", 0.005)),
        "d": float(env.get("d", 0.1)),
        "s": float(env.get("s", 1.0)) * 100.0,
        "r": float(env.get("r", 0.25)),
    }


def _basename(path: str) -> str:
    return Path(path).name


def _lovel(value) -> int:
    """SFZ velocities are 1-127; lovel=0 is out of spec (sfzlint flags it)."""
    return max(1, int(value))


def render_sfz(instrument: dict) -> str:
    """A multisample or drumkit dict -> SFZ text."""
    env = _env(instrument)
    name = instrument.get("name", "instrument")
    is_kit = instrument.get("type") == "drumkit"
    out = _HEADER.format(name=name, a=env["a"], d=env["d"], s=env["s"], r=env["r"])
    if is_kit:
        out += "loop_mode=one_shot\n"
    out += "\n"

    if is_kit:
        for piece, data in instrument.get("pieces", {}).items():
            zones = data.get("zones", [])
            rr_total = len({z.get("rr", 0) for z in zones})
            out += f"// {piece}\n"
            for z in zones:
                pitch = int(data.get("gm", 38))
                line = (
                    f"<region> sample={_basename(z['path'])} "
                    f"key={pitch} pitch_keycenter={pitch} "
                    f"lovel={_lovel(z.get('lovel', 1))} hivel={int(z.get('hivel', 127))}"
                )
                if rr_total > 1:
                    line += f" seq_length={rr_total} seq_position={int(z.get('rr', 0)) + 1}"
                out += line + "\n"
            out += "\n"
        return out

    for z in instrument.get("zones", []):
        line = (
            f"<region> sample={_basename(z['path'])} "
            f"lokey={int(z.get('lo', 0))} hikey={int(z.get('hi', 127))} "
            f"pitch_keycenter={int(z.get('root', 60))} "
            f"lovel={_lovel(z.get('lovel', 1))} hivel={int(z.get('hivel', 127))}"
        )
        loop = z.get("loop")
        if loop:
            line += (
                f" loop_mode=loop_continuous "
                f"loop_start={int(loop['start'])} loop_end={int(loop['end'])}"
            )
        if z.get("gain_db"):
            line += f" volume={float(z['gain_db']):.2f}"
        out += line + "\n"
    return out


def write_sfz(instrument: dict, path: str | Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render_sfz(instrument))
    return path
