"""CLI: python -m stemflipper song.mp3 -o out/ --preset best"""

import argparse
import sys
from pathlib import Path

from .pipeline import MODEL_ALIASES, run_pipeline
from .separate import MODELS
from .separation import DEFAULT_PRESET, PRESETS


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="stemflipper",
        description="song -> stems -> MIDI + samples -> editable instruments -> bundle",
    )
    parser.add_argument("input", help="audio file (wav/mp3/flac/m4a)")
    parser.add_argument("-o", "--output", default="out", help="output directory")
    parser.add_argument(
        "--preset",
        default=None,
        choices=sorted(PRESETS),
        help=(
            "separation quality/cost: "
            "fast = htdemucs only; "
            "balanced = RoFormer vocals + htdemucs + drum split; "
            f"best = RoFormer vocals + htdemucs_ft + drum split (default: {DEFAULT_PRESET})"
        ),
    )
    parser.add_argument(
        "--six",
        action="store_true",
        help="also split guitar/piano out of `other` (experimental; piano bleeds)",
    )
    parser.add_argument(
        "--model",
        default=None,
        help=f"v1 alias for --preset ({', '.join(f'{k}->{v}' for k, v in MODEL_ALIASES.items())})",
    )
    parser.add_argument("--model-dir", default=None, help="model weight cache dir")
    parser.add_argument("--workers", type=int, default=3, help="per-stem worker threads")
    parser.add_argument("--no-zip", action="store_true", help="skip bundle zip")
    args = parser.parse_args(argv)

    if not Path(args.input).exists():
        print(f"error: no such file: {args.input}", file=sys.stderr)
        return 2
    if args.model and args.model not in MODELS and not args.preset:
        print(f"note: unknown --model {args.model!r}; using preset {DEFAULT_PRESET}", file=sys.stderr)

    def progress(frac, desc):
        print(f"[{frac * 100:5.1f}%] {desc}", flush=True)

    result = run_pipeline(
        args.input,
        args.output,
        model=args.model,
        model_dir=args.model_dir,
        progress=progress,
        make_zip=not args.no_zip,
        preset=args.preset,
        six=args.six,
        workers=args.workers,
    )
    manifest = result["manifest"]
    project = result.get("project") or {}
    print(f"\nbundle:  {result['bundle_dir']}")
    if result["zip_path"]:
        print(f"zip:     {result['zip_path']}")
    print(f"tempo:   {manifest['tempo']} BPM   key: {manifest['key']}   "
          f"time sig: {manifest.get('time_signature', '4/4')}")
    for step in (project.get("separation") or {}).get("chain", []):
        print(f"  chain:  {step['step']:16s} {step['model']}  {step['seconds']}s")
    for name, meta in manifest["stems"].items():
        note = "silent" if meta["silent"] else f"{meta['n_notes']} notes"
        sfz = " +sfz" if meta["instrument_sfz"] else ""
        print(f"  {name:8s} {note}{sfz}")
    degraded = [s for s in project.get("stages", []) if s["status"] in ("failed", "fallback")]
    for s in degraded:
        print(f"  ! {s['name']}: {s['status']} — {s['detail']}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
