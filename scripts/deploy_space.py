"""Deploy the repo to the Hugging Face Space (creates it if missing).

Usage: .venv/bin/python scripts/deploy_space.py [--space-id USER/NAME]
Requires a logged-in HF token with write scope (`hf auth login`).
"""

import argparse
from pathlib import Path

from huggingface_hub import HfApi

REPO_ROOT = Path(__file__).resolve().parent.parent
# Only runtime files go to the (public) Space — internal docs (PLAN.md, HANDOFF.md,
# research/), tests, and scripts stay local-only.
ALLOW = [
    "app.py", "requirements.txt", "packages.txt", "README.md", "stemflipper/*.py",
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--space-id", default=None, help="defaults to <me>/stemflipper")
    args = parser.parse_args()

    api = HfApi()
    me = api.whoami()["name"]
    space_id = args.space_id or f"{me}/stemflipper"

    # HF now requires PRO to CREATE a Gradio Space on free cpu-basic (create_repo
    # returns 402). The Space already exists, so only create it if missing and treat a
    # 402 as "it exists / can't create on this plan" and proceed straight to upload.
    try:
        api.create_repo(
            repo_id=space_id, repo_type="space", space_sdk="gradio", exist_ok=True
        )
    except Exception as e:
        if "402" not in str(e):
            raise
        print("note: create_repo blocked (402 / PRO required) — Space must already "
              "exist; uploading to it directly.")
    api.upload_folder(
        repo_id=space_id,
        repo_type="space",
        folder_path=str(REPO_ROOT),
        allow_patterns=ALLOW,
        commit_message="deploy from local repo (runtime files only)",
    )
    print(f"deployed: https://huggingface.co/spaces/{space_id}")


if __name__ == "__main__":
    main()
