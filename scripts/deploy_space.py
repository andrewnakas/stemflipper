"""Deploy the repo to the Hugging Face Space (creates it if missing).

Usage: .venv/bin/python scripts/deploy_space.py [--space-id USER/NAME]
Requires a logged-in HF token with write scope (`hf auth login`).
"""

import argparse
from pathlib import Path

from huggingface_hub import HfApi

REPO_ROOT = Path(__file__).resolve().parent.parent
EXCLUDE = [
    ".git/*", ".venv/*", "__pycache__/*", "*/__pycache__/*", ".pytest_cache/*",
    "tests/assets/*", "models/*", "out/*", ".claude/*", ".DS_Store",
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--space-id", default=None, help="defaults to <me>/stemflipper")
    args = parser.parse_args()

    api = HfApi()
    me = api.whoami()["name"]
    space_id = args.space_id or f"{me}/stemflipper"

    api.create_repo(
        repo_id=space_id, repo_type="space", space_sdk="gradio", exist_ok=True
    )
    api.upload_folder(
        repo_id=space_id,
        repo_type="space",
        folder_path=str(REPO_ROOT),
        ignore_patterns=EXCLUDE,
        commit_message="deploy from local repo",
    )
    print(f"deployed: https://huggingface.co/spaces/{space_id}")


if __name__ == "__main__":
    main()
