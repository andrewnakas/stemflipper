"""Finish the v2 cutover: deploy the Space, verify it, then switch the site to the editor.

The backend and the frontend must go live TOGETHER — the v2 editor speaks the v2 `/flip`
signature and the v1 client speaks the old one, so whichever ships alone breaks the live
page for visitors. This does both in the right order and refuses to switch the site if the
Space did not come up.

    .venv/bin/python scripts/finish_deploy.py            # deploy, verify, switch, push
    .venv/bin/python scripts/finish_deploy.py --check    # just report what would happen
    .venv/bin/python scripts/finish_deploy.py --no-push  # do everything except git push

Auth: `.venv/bin/hf auth login`, or set HF_TOKEN.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SPACE_ID = os.environ.get("STEMFLIPPER_SPACE", "nakas/stemflipper")
SPACE_HOST = "https://" + SPACE_ID.replace("/", "-") + ".hf.space"
BUILD_TIMEOUT_S = 900
PAGES_TIMEOUT_S = 420

INDEX_V2 = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" type="image/svg+xml" href="/stemflipper/favicon.svg" />
    <title>StemFlipper</title>
    <meta http-equiv="refresh" content="0; url=./app.html" />
    <link rel="canonical" href="https://andrewnakas.github.io/stemflipper/app.html" />
  </head>
  <body>
    <p style="font: 14px system-ui; padding: 24px">
      Loading the StemFlipper editor… <a href="./app.html">continue</a>
    </p>
  </body>
</html>
"""


def say(msg: str) -> None:
    print(msg, flush=True)


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=REPO, text=True, capture_output=True, **kw)


def api_signature() -> dict | None:
    """The live Space's /flip signature, or None if it is not answering."""
    try:
        with urllib.request.urlopen(f"{SPACE_HOST}/gradio_api/info", timeout=45) as r:
            info = json.load(r)
    except Exception:
        return None
    ep = (info.get("named_endpoints") or {}).get("/flip")
    if not ep:
        return None
    return {
        "params": [p.get("parameter_name") for p in ep.get("parameters", [])],
        "n_returns": len(ep.get("returns", [])),
    }


def is_v2(sig: dict | None) -> bool:
    return bool(sig and "preset" in (sig.get("params") or []))


def space_stage() -> str:
    """The Space's build/run stage. `space_info().runtime` is a SpaceRuntime OBJECT with
    a `.stage` attribute, not a dict — treating it as one silently reported 'unknown'
    forever and would have timed out a perfectly good deploy."""
    from huggingface_hub import HfApi

    runtime = HfApi(token=os.environ.get("HF_TOKEN") or None).space_info(SPACE_ID).runtime
    if runtime is None:
        return "UNKNOWN"
    stage = getattr(runtime, "stage", None)
    if stage is None and hasattr(runtime, "get"):
        stage = runtime.get("stage")
    return str(stage or "UNKNOWN")


def check_auth() -> str | None:
    from huggingface_hub import HfApi

    try:
        return HfApi(token=os.environ.get("HF_TOKEN") or None).whoami()["name"]
    except Exception:
        return None


def wait_for_space() -> bool:
    """Poll until the Space is RUNNING and serving the v2 signature."""
    deadline = time.time() + BUILD_TIMEOUT_S
    last = ""
    while time.time() < deadline:
        try:
            stage = space_stage()
        except Exception as e:
            stage = f"UNKNOWN ({type(e).__name__}: {e})"
        if stage != last:
            say(f"  space stage: {stage}")
            last = stage
        if stage in ("RUNTIME_ERROR", "BUILD_ERROR", "CONFIG_ERROR"):
            say(f"  ✗ the Space failed to start ({stage}) — check its logs on huggingface.co")
            return False
        if stage == "RUNNING":
            sig = api_signature()
            if is_v2(sig):
                say(f"  ✓ v2 API live: flip({', '.join(sig['params'])}) -> {sig['n_returns']} outputs")
                return True
        time.sleep(15)
    say("  ✗ timed out waiting for the Space to serve the v2 API")
    return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="report state and exit")
    ap.add_argument("--no-push", action="store_true", help="skip the git push")
    args = ap.parse_args()

    say(f"space:  https://huggingface.co/spaces/{SPACE_ID}")
    sig = api_signature()
    say(f"live API: {'v2 (already deployed)' if is_v2(sig) else 'v1' if sig else 'not answering'}")
    user = check_auth()
    say(f"hf auth: {user or 'NOT AUTHENTICATED'}")

    if args.check:
        say("\n--check only, nothing changed.")
        return 0

    if not user:
        say(
            "\nNot authenticated. Run this first, then re-run me:\n"
            "    .venv/bin/hf auth login\n"
            "  (or set HF_TOKEN=hf_... in the environment)"
        )
        return 1

    # 1. Deploy the Space
    if is_v2(sig):
        say("\n[1/4] Space already serves the v2 API — skipping the upload.")
    else:
        say("\n[1/4] Uploading runtime files to the Space…")
        proc = run([sys.executable, "scripts/deploy_space.py"])
        say("  " + (proc.stdout or proc.stderr).strip().replace("\n", "\n  "))
        if proc.returncode != 0:
            say("  ✗ deploy failed — the site was NOT switched.")
            return 1

        say("\n[2/4] Waiting for the Space to rebuild (a few minutes on a cold build)…")
        if not wait_for_space():
            say("  ✗ the site was NOT switched; the v1 client is still live and working.")
            return 1

    # 2. Switch the site to the editor
    say("\n[3/4] Switching the site root to the v2 editor…")
    index = REPO / "web" / "index.html"
    if "app.html" in index.read_text() and "legacy" not in index.read_text():
        say("  already switched.")
    else:
        index.write_text(INDEX_V2)
        legacy = REPO / "web" / "public" / "legacy"
        if legacy.exists():
            run(["git", "rm", "-r", "-q", str(legacy.relative_to(REPO))])
            say("  removed the v1 client")
        run(["git", "add", "-A"])
        message = (
            "Switch the site to the v2 editor\n\n"
            "The Space now serves the v2 /flip API, so the editor becomes the site root and\n"
            "the v1 client is removed. Backend and frontend change together because the API\n"
            "shape changed: either one alone would break the live page.\n\n"
            "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>\n"
        )
        proc = run(["git", "commit", "-q", "-m", message])
        if proc.returncode != 0 and "nothing to commit" not in (proc.stdout + proc.stderr):
            say("  ✗ commit failed: " + (proc.stdout + proc.stderr).strip())
            return 1

    if args.no_push:
        say("\n[4/4] --no-push: commit made, not pushed.")
        return 0

    say("\n[4/4] Pushing (GitHub Actions rebuilds the site)…")
    proc = run(["git", "push", "origin", "main"])
    if proc.returncode != 0:
        say("  ✗ push failed: " + (proc.stdout + proc.stderr).strip())
        return 1

    deadline = time.time() + PAGES_TIMEOUT_S
    while time.time() < deadline:
        time.sleep(20)
        try:
            with urllib.request.urlopen(
                "https://andrewnakas.github.io/stemflipper/", timeout=30
            ) as r:
                body = r.read().decode("utf-8", "replace")
            if "app.html" in body:
                say("  ✓ live: https://andrewnakas.github.io/stemflipper/")
                say("\nDone. The editor is the site and the Space serves it.")
                return 0
        except Exception:
            pass
    say("  … pushed; the Pages build is still running. Check `gh run list`.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
