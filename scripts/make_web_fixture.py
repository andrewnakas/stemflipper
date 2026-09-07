"""Generate a real StemFlipper bundle for the web app to develop and test against.

The frontend must be buildable and testable with no backend and no network: this script
renders the deterministic synthetic song from tests/make_fixture.py, runs the real
pipeline with separation stubbed (same stand-in the pipeline tests use), converts the
result to a v2 project.json, and copies the bundle into web/public/fixtures/song/.

    .venv/bin/python scripts/make_web_fixture.py

The page then loads it with ?fixture=song. Re-run this after any change to the bundle
layout or the project.json contract (it is regenerated from the native v2 pipeline in P3).
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "tests"))

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402

from make_fixture import build_fixture  # noqa: E402
from stemflipper.export import project_json  # noqa: E402
from stemflipper.pipeline import run_pipeline  # noqa: E402

OUT_DIR = REPO_ROOT / "web" / "public" / "fixtures" / "song"


def _stub_separator(paths: dict):
    """Copy the fixture's true stems (lead -> other) + a silent vocals stem."""

    def separate_fn(input_path, output_dir, model=None, model_dir=None):
        out = {}
        for stem, src in {"drums": "drums", "bass": "bass", "other": "lead"}.items():
            target = Path(output_dir) / f"raw_{stem}.wav"
            shutil.copy(paths[src], target)
            out[stem] = target
        silent = Path(output_dir) / "raw_vocals.wav"
        sf.write(str(silent), np.zeros(44100), 44100)
        out["vocals"] = silent
        return out

    return separate_fn


def main() -> int:
    work = Path(tempfile.mkdtemp(prefix="sf_fixture_"))
    fixture = build_fixture(work / "src")
    print(f"fixture song: {fixture['paths']['mix']}")

    result = run_pipeline(
        fixture["paths"]["mix"],
        work / "out",
        progress=lambda frac, desc: print(f"[{frac:5.0%}] {desc}"),
        make_zip=False,
        separate_fn=_stub_separator(fixture["paths"]),
        use_panns=False,
    )
    bundle = Path(result["bundle_dir"])

    manifest = json.loads((bundle / "manifest.json").read_text())
    notes = json.loads((bundle / "notes.json").read_text())
    project = project_json.from_v1(manifest, notes, bundle)

    errors = project_json.validate_project(project, bundle)
    if errors:
        print("project.json did NOT validate:", file=sys.stderr)
        for e in errors:
            print("  -", e, file=sys.stderr)
        return 1

    if OUT_DIR.exists():
        shutil.rmtree(OUT_DIR)
    shutil.copytree(bundle, OUT_DIR)
    project_json.write_project(OUT_DIR, project)
    total = sum(len(t["notes"]) for t in project["tracks"])
    print(
        f"wrote {OUT_DIR.relative_to(REPO_ROOT)} — {len(project['tracks'])} tracks, "
        f"{total} notes, tempo {project['grid']['tempo']}, key {project['key']['name']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
