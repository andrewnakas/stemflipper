"""DecentSampler .dspreset writer (XML).

DecentSampler is free on every desktop platform, so this is the format most users can
actually open without buying anything.
"""

from __future__ import annotations

from pathlib import Path
from xml.sax.saxutils import quoteattr


def _attr(value) -> str:
    return quoteattr(str(value))


def _rel(path: str, root: str) -> str:
    p = str(path)
    prefix = f"{root}/"
    return p[p.index(prefix) + len(prefix):] if prefix in p else Path(p).name


def render_dspreset(instrument: dict, effects: dict | None = None) -> str:
    name = instrument.get("name", "instrument")
    env = instrument.get("amp_env") or {}
    is_kit = instrument.get("type") == "drumkit"
    root = f"instruments/{name}"

    lines = ['<?xml version="1.0" encoding="UTF-8"?>']
    lines.append(f'<DecentSampler minVersion="1.0.0" name={_attr(name)}>')
    lines.append("  <groups>")
    group_attrs = (
        f'attack="{float(env.get("a", 0.005)):.4f}" '
        f'decay="{float(env.get("d", 0.1)):.4f}" '
        f'sustain="{float(env.get("s", 1.0)):.3f}" '
        f'release="{float(env.get("r", 0.25)):.4f}"'
    )

    if is_kit:
        for piece, data in instrument.get("pieces", {}).items():
            pitch = int(data.get("gm", 38))
            lines.append(f'    <group name={_attr(piece)} {group_attrs}>')
            for z in data.get("zones", []):
                lines.append(
                    f'      <sample path={_attr(_rel(z["path"], root))} '
                    f'rootNote="{pitch}" loNote="{pitch}" hiNote="{pitch}" '
                    f'loVel="{int(z.get("lovel", 0))}" hiVel="{int(z.get("hivel", 127))}" '
                    f'trigger="attack" />'
                )
            lines.append("    </group>")
    else:
        lines.append(f"    <group {group_attrs}>")
        for z in instrument.get("zones", []):
            loop = z.get("loop")
            loop_attrs = ""
            if loop:
                loop_attrs = (
                    f' loopStart="{int(loop["start"])}" loopEnd="{int(loop["end"])}"'
                    f' loopEnabled="true" loopCrossfade="{int(loop.get("crossfade", 0))}"'
                )
            lines.append(
                f'      <sample path={_attr(_rel(z["path"], root))} '
                f'rootNote="{int(z.get("root", 60))}" '
                f'loNote="{int(z.get("lo", 0))}" hiNote="{int(z.get("hi", 127))}" '
                f'loVel="{int(z.get("lovel", 0))}" hiVel="{int(z.get("hivel", 127))}"'
                f"{loop_attrs} />"
            )
        lines.append("    </group>")
    lines.append("  </groups>")

    reverb = (effects or {}).get("reverb") or {}
    if reverb.get("wet") and float(reverb.get("rt60_s", 0)) > 0:
        wet = min(0.6, float(reverb.get("mix", 0.2)))
        size = min(1.0, float(reverb.get("rt60_s", 1.0)) / 3.0)
        lines.append("  <effects>")
        lines.append(f'    <effect type="reverb" wetLevel="{wet:.2f}" roomSize="{size:.2f}" />')
        lines.append("  </effects>")

    lines.append("</DecentSampler>")
    return "\n".join(lines) + "\n"


def write_dspreset(instrument: dict, path: str | Path, effects: dict | None = None) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render_dspreset(instrument, effects))
    return path
