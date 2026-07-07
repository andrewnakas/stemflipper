"""CLI: python -m stemflipper song.mp3 -o out/"""

import argparse
import sys
from pathlib import Path

from .pipeline import run_pipeline
from .separate import DEFAULT_MODEL, MODELS


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="stemflipper",
        description="song -> stems -> MIDI -> editable instruments -> DAW bundle",
    )
    parser.add_argument("input", help="audio file (wav/mp3/flac/m4a)")
    parser.add_argument("-o", "--output", default="out", help="output directory")
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help=f"separation model: {', '.join(MODELS)} (or any audio-separator filename)",
    )
    parser.add_argument("--model-dir", default=None, help="model weight cache dir")
    parser.add_argument("--no-zip", action="store_true", help="skip bundle zip")
    args = parser.parse_args(argv)

    if not Path(args.input).exists():
        print(f"error: no such file: {args.input}", file=sys.stderr)
        return 2

    def progress(frac, desc):
        print(f"[{frac * 100:5.1f}%] {desc}", flush=True)

    result = run_pipeline(
        args.input,
        args.output,
        model=args.model,
        model_dir=args.model_dir,
        progress=progress,
        make_zip=not args.no_zip,
    )
    manifest = result["manifest"]
    print(f"\nbundle:  {result['bundle_dir']}")
    if result["zip_path"]:
        print(f"zip:     {result['zip_path']}")
    print(f"tempo:   {manifest['tempo']} BPM   key: {manifest['key']}")
    for name, meta in manifest["stems"].items():
        note = "silent" if meta["silent"] else f"{meta['n_notes']} notes"
        sfz = " +sfz" if meta["instrument_sfz"] else ""
        print(f"  {name:8s} {note}{sfz}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
