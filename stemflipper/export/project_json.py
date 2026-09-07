"""project.json — the single contract between the pipeline and the web app.

Schema version 2. Everything the browser needs to render, play, edit and re-export a
song lives here: the beat grid, per-track notes, the assets each track owns (stem audio,
sampler instrument, synth patch, effects, loops, phrases) and a per-stage status trail
so a degraded run is visible instead of silently empty (Invariant #7).

Asset references are ALWAYS bundle-relative POSIX strings under the key ``src`` so the
same file works from a zip, from a local server and from the Space's /gradio_api/file=
route. The key is ``src`` and not ``path`` deliberately: Gradio serialises any
``{"path": str}`` dict as a file reference and then tries to serve it, which corrupts the
contract in transit (it 403s on relative paths).
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 2

# note rows are compact on purpose: the browser parses tens of thousands of them
# [pitch, start_s, end_s, velocity, confidence]
NOTE_ROW_LEN = 5

STAGE_STATUSES = ("ok", "fallback", "skipped", "failed")
TRACK_KINDS = ("pitched", "drums")

_TRACK_COLORS = {
    "vocals": "#e0a458",
    "drums": "#6ad5c0",
    "bass": "#8a7fe8",
    "guitar": "#e07a7a",
    "piano": "#7ab8e0",
    "other": "#9aa7b8",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def note_rows(notes: list[dict]) -> list[list]:
    """[{pitch,start,end,velocity,confidence?}] -> compact rows."""
    rows = []
    for n in notes:
        rows.append(
            [
                int(n["pitch"]),
                round(float(n["start"]), 4),
                round(float(n["end"]), 4),
                int(n["velocity"]),
                round(float(n.get("confidence", 0.7)), 3),
            ]
        )
    return rows


def rows_to_notes(rows: list[list]) -> list[dict]:
    """Inverse of note_rows (used by tests and any backend re-import of edits)."""
    out = []
    for r in rows:
        out.append(
            {
                "pitch": int(r[0]),
                "start": float(r[1]),
                "end": float(r[2]),
                "velocity": int(r[3]),
                "confidence": float(r[4]) if len(r) > 4 else 0.7,
            }
        )
    return out


def track_entry(
    name: str,
    *,
    audio: dict,
    notes: list[dict] | None = None,
    kind: str | None = None,
    role: str | None = None,
    sub_stems: list[dict] | None = None,
    character: dict | None = None,
    transcription: dict | None = None,
    instrument: dict | None = None,
    effects: dict | None = None,
    loops: list[dict] | None = None,
    phrases: list[dict] | None = None,
    f0: dict | None = None,
    midi: str | None = None,
) -> dict:
    """One track's contract entry. Only `name` and `audio` are required."""
    role = role or name
    return {
        "id": name,
        "name": name.capitalize(),
        "role": role,
        "kind": kind or ("drums" if role == "drums" else "pitched"),
        "color": _TRACK_COLORS.get(role, "#9aa7b8"),
        "audio": audio,
        "sub_stems": sub_stems or [],
        "character": character or {},
        "transcription": transcription or {},
        "notes": note_rows(notes or []),
        "f0": f0,
        "instrument": instrument
        or {"sampler": None, "sfz": None, "dspreset": None, "patch": None, "vital": None},
        "effects": effects,
        "loops": loops or [],
        "phrases": phrases or [],
        "midi": midi,
    }


def stage(name: str, status: str, seconds: float = 0.0, detail: str = "") -> dict:
    return {
        "name": name,
        "status": status if status in STAGE_STATUSES else "failed",
        "seconds": round(float(seconds), 2),
        "detail": detail,
    }


def build_project(
    *,
    source_file: str,
    duration: float,
    sample_rate: int,
    channels: int = 2,
    app_version: str = "2.0.0",
    grid: dict,
    key: dict | None = None,
    chords: list[dict] | None = None,
    sections: list[dict] | None = None,
    separation: dict | None = None,
    tracks: list[dict],
    midi: dict | None = None,
    exports: dict | None = None,
    stages: list[dict] | None = None,
) -> dict:
    return {
        "schema_version": SCHEMA_VERSION,
        "app": {"name": "stemflipper", "version": app_version, "created_utc": utc_now()},
        "song": {
            "source_file": source_file,
            "duration": round(float(duration), 3),
            "sample_rate": int(sample_rate),
            "channels": int(channels),
        },
        "grid": grid,
        "key": key or {"name": "unknown", "tonic": None, "mode": None, "confidence": 0.0},
        "chords": chords or [],
        "sections": sections or [],
        "separation": separation or {},
        "tracks": tracks,
        "midi": midi or {"song": None, "chords": None},
        "exports": exports or {},
        "stages": stages or [],
    }


def grid_entry(
    tempo: float,
    beats: list[float],
    *,
    downbeats: list[float] | None = None,
    time_signature: str = "4/4",
    tempo_map: list[list[float]] | None = None,
    source: str = "librosa",
) -> dict:
    return {
        "tempo": round(float(tempo), 2),
        "time_signature": time_signature,
        "beats": [round(float(b), 4) for b in beats],
        "downbeats": [round(float(b), 4) for b in (downbeats or [])],
        "tempo_map": tempo_map or [[0.0, round(float(tempo), 2)]],
        "source": source,
    }


# --------------------------------------------------------------------------- validate

ASSET_KEY = "src"


def _is_relative(path: str) -> bool:
    return not path.startswith("/") and ".." not in Path(path).parts


def validate_project(d: dict, bundle_dir: str | Path | None = None) -> list[str]:
    """Return a list of problems; empty list means valid.

    When bundle_dir is given, every referenced asset must also exist on disk.
    """
    errs: list[str] = []

    def req(obj, key, where, types=None):
        if key not in obj:
            errs.append(f"{where}: missing '{key}'")
            return None
        if types is not None and not isinstance(obj[key], types):
            errs.append(f"{where}.{key}: expected {types}, got {type(obj[key]).__name__}")
        return obj.get(key)

    if d.get("schema_version") != SCHEMA_VERSION:
        errs.append(f"schema_version must be {SCHEMA_VERSION}, got {d.get('schema_version')!r}")

    for key, types in (
        ("app", dict), ("song", dict), ("grid", dict), ("key", dict),
        ("chords", list), ("sections", list), ("separation", dict),
        ("tracks", list), ("midi", dict), ("exports", dict), ("stages", list),
    ):
        req(d, key, "project", types)

    song = d.get("song", {})
    for key, types in (("source_file", str), ("duration", (int, float)), ("sample_rate", int)):
        req(song, key, "song", types)

    grid = d.get("grid", {})
    req(grid, "tempo", "grid", (int, float))
    req(grid, "beats", "grid", list)
    req(grid, "time_signature", "grid", str)
    if not isinstance(grid.get("tempo_map"), list) or not grid.get("tempo_map"):
        errs.append("grid.tempo_map: expected a non-empty list of [seconds, bpm]")

    assets: list[str] = []
    for i, t in enumerate(d.get("tracks", []) or []):
        where = f"tracks[{i}]"
        tid = req(t, "id", where, str)
        req(t, "audio", where, dict)
        kind = t.get("kind")
        if kind not in TRACK_KINDS:
            errs.append(f"{where}.kind: expected one of {TRACK_KINDS}, got {kind!r}")
        audio_path = (t.get("audio") or {}).get(ASSET_KEY)
        if audio_path:
            if not _is_relative(audio_path):
                errs.append(f"{where}.audio.{ASSET_KEY}: must be bundle-relative, got {audio_path!r}")
            assets.append(audio_path)
        for j, row in enumerate(t.get("notes") or []):
            if not isinstance(row, list) or len(row) != NOTE_ROW_LEN:
                errs.append(f"{where}.notes[{j}]: expected {NOTE_ROW_LEN} elements, got {row!r}")
                break
            if row[2] < row[1]:
                errs.append(f"{where}.notes[{j}]: end {row[2]} before start {row[1]}")
                break
        for key, val in (t.get("instrument") or {}).items():
            if isinstance(val, str):
                if not _is_relative(val):
                    errs.append(f"{where}.instrument.{key}: must be bundle-relative, got {val!r}")
                assets.append(val)
        for sub in t.get("sub_stems") or []:
            if sub.get(ASSET_KEY):
                assets.append(sub[ASSET_KEY])
        for coll in ("loops", "phrases"):
            for item in t.get(coll) or []:
                if item.get(ASSET_KEY):
                    assets.append(item[ASSET_KEY])
        if tid and t.get("midi"):
            assets.append(t["midi"])

    for s in d.get("stages", []) or []:
        if s.get("status") not in STAGE_STATUSES:
            errs.append(f"stages: bad status {s.get('status')!r} for {s.get('name')!r}")

    if bundle_dir is not None:
        root = Path(bundle_dir)
        for rel in assets:
            if not (root / rel).exists():
                errs.append(f"missing asset on disk: {rel}")

    return errs


def write_project(bundle_dir: str | Path, project: dict) -> Path:
    path = Path(bundle_dir) / "project.json"
    path.write_text(json.dumps(project, indent=2))
    return path


# --------------------------------------------------------------------------- v1 shim

def from_v1(manifest: dict, notes: dict, bundle_dir: str | Path | None = None) -> dict:
    """Build a v2 project from a v1 manifest.json + notes.json.

    Used by scripts/make_web_fixture.py so the frontend can be developed against a real
    bundle before the P3 pipeline emits v2 natively.
    """
    stems = manifest.get("stems", {}) or {}
    note_stems = (notes or {}).get("stems", {}) or {}
    tracks = []
    for name, meta in stems.items():
        entry = note_stems.get(name, {})
        rows = entry.get("notes", []) or []
        is_drum = bool(entry.get("is_drum", name == "drums"))
        instrument = {
            "sampler": None,
            "sfz": meta.get("instrument_sfz"),
            "dspreset": None,
            "patch": None,
            "vital": meta.get("instrument_vital"),
        }
        effects = None
        if meta.get("effects") and bundle_dir is not None:
            try:
                fx = json.loads((Path(bundle_dir) / meta["effects"]).read_text())
                effects = {
                    "eq": {
                        "bands": [
                            {"type": "peaking", "freq": f, "gain_db": g, "q": 1.0}
                            for f, g in fx.get("eq_curve", [])
                        ],
                        "match_bands": None,
                    },
                    "reverb": {
                        "rt60_s": fx.get("rt60_s", 0.0),
                        "wet": bool(fx.get("wet")),
                        "ir": fx.get("ir_wav"),
                        "mix": 0.2 if fx.get("wet") else 0.0,
                    },
                }
            except Exception:
                effects = None
        tracks.append(
            track_entry(
                name,
                audio={ASSET_KEY: meta.get("audio"), "silent": bool(meta.get("silent")),
                       "peak_db": None, "lufs": None},
                kind="drums" if is_drum else "pitched",
                character={
                    "strategy": meta.get("strategy"),
                    "instrument": meta.get("instrument"),
                    "polyphonic": meta.get("polyphonic"),
                    "synth_like": meta.get("synth_like"),
                    "wet": meta.get("wet"),
                    "low_confidence": bool(meta.get("low_confidence")),
                    "scores": meta.get("router_scores", {}),
                },
                transcription={
                    "engine": "basic_pitch" if not is_drum else "drums_heuristic",
                    "fallback": None,
                    "n_notes": len(rows),
                    "quantized": True,
                    "subdivision": 4,
                },
                notes=rows_to_notes([list(r) + [0.7] for r in rows]),
                instrument=instrument,
                effects=effects,
                midi=meta.get("midi"),
            )
        )

    grid = grid_entry(
        manifest.get("tempo", 120.0),
        (notes or {}).get("beats", []) or [],
        time_signature=manifest.get("time_signature", "4/4"),
        source="librosa",
    )
    key_name = manifest.get("key", "unknown")
    return build_project(
        source_file=manifest.get("source_file", "song"),
        duration=manifest.get("duration", (notes or {}).get("duration", 0.0)),
        sample_rate=manifest.get("sample_rate", 44100),
        app_version=manifest.get("version", "1.0.0"),
        grid=grid,
        key={"name": key_name, "tonic": None, "mode": None, "confidence": 0.0},
        separation={
            "preset": "legacy",
            "device": "cpu",
            "gpu_seconds": 0.0,
            "chain": [
                {
                    "step": "stems",
                    "model": manifest.get("separation_model", "htdemucs"),
                    "input": "mix",
                    "seconds": 0.0,
                }
            ],
        },
        tracks=tracks,
        midi={"song": "midi/song.mid", "chords": None},
        exports={"dawproject": manifest.get("dawproject"), "readme": "README.txt"},
        stages=[stage("separate", "ok"), stage("transcribe", "ok"), stage("bundle", "ok")],
    )
