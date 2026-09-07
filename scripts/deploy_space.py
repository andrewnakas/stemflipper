"""Deploy the repo's runtime files to the Hugging Face Space.

Usage:
    .venv/bin/python scripts/deploy_space.py [--space-id USER/NAME] [--dry-run]

Auth: `hf auth login` (write scope), or set HF_TOKEN in the environment for headless runs.
The Space already exists and is grandfathered on ZeroGPU — this script never creates it
(HF returns 402 / PRO-required for new Gradio Spaces on free hardware).
"""

import argparse
import os
import sys
from pathlib import Path

from huggingface_hub import HfApi
from huggingface_hub.utils import filter_repo_objects

REPO_ROOT = Path(__file__).resolve().parent.parent

# Only runtime files go to the (public) Space — internal docs (PLAN.md, PLAN_V2.md,
# HANDOFF.md, research/), tests/, scripts/, dataset/ and web/ stay local-only.
# NOTE: the stemflipper/ patterns must be RECURSIVE — v2 adds subpackages
# (analysis/, separation/, transcription/, samples/, export/) and a flat
# "stemflipper/*.py" would silently ship a half-broken package.
ALLOW = [
    "app.py",
    "requirements.txt",
    "packages.txt",
    "README.md",
    "stemflipper/*.py",
    "stemflipper/**/*.py",
]
IGNORE = ["**/__pycache__/**", "**/*.pyc"]


def _files_to_upload() -> list[str]:
    rels = [
        str(p.relative_to(REPO_ROOT))
        for p in REPO_ROOT.rglob("*")
        if p.is_file() and ".git/" not in str(p)
    ]
    return sorted(filter_repo_objects(rels, allow_patterns=ALLOW, ignore_patterns=IGNORE))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--space-id", default=None, help="defaults to <me>/stemflipper")
    parser.add_argument(
        "--dry-run", action="store_true", help="list the files that would be uploaded and exit"
    )
    args = parser.parse_args()

    files = _files_to_upload()
    if args.dry_run:
        print(f"{len(files)} file(s) would be uploaded:")
        for f in files:
            print("  ", f)
        return 0
    if not files:
        print("refusing to deploy: the allow-list matched no files", file=sys.stderr)
        return 1

    api = HfApi(token=os.environ.get("HF_TOKEN") or None)
    try:
        me = api.whoami()["name"]
    except Exception as e:
        print(f"not authenticated ({e}). Run `hf auth login` or set HF_TOKEN.", file=sys.stderr)
        return 1
    space_id = args.space_id or f"{me}/stemflipper"

    api.upload_folder(
        repo_id=space_id,
        repo_type="space",
        folder_path=str(REPO_ROOT),
        allow_patterns=ALLOW,
        ignore_patterns=IGNORE,
        commit_message="deploy from local repo (runtime files only)",
    )
    print(f"deployed {len(files)} files: https://huggingface.co/spaces/{space_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
