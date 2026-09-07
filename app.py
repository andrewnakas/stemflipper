"""StemFlipper Gradio app — thin adapter over stemflipper.pipeline.

The same file runs locally, on a CPU Space and on ZeroGPU. All neural work happens in ONE
`@spaces.GPU` call (Invariant #9) whose duration is estimated from the song and preset:
ZeroGPU bills GPU seconds and gives anonymous API callers 2 minutes a day, so a flat
request would burn a visitor's whole quota on a short song.

API: flip(audio, preset, six) -> [bundle.zip, project.json]
project.json is the contract the web app renders, plays and edits from.
"""

import json
import os
import shutil
import tempfile
import time
from pathlib import Path

import gradio as gr

from stemflipper import neural, separate
from stemflipper.audio_io import duration_of
from stemflipper.pipeline import run_pipeline
from stemflipper.separation import DEFAULT_PRESET, PRESETS

MAX_AUDIO_MINUTES = 8
WORK_ROOT = Path(os.environ.get("STEMFLIPPER_WORK", tempfile.gettempdir())) / "stemflipper"
WORK_ROOT.mkdir(parents=True, exist_ok=True)
WORKDIR_TTL_H = 6

EDITOR_URL = "https://andrewnakas.github.io/stemflipper/"

# PANNs CNN14 (~340 MB) is off by default so a cold Space isn't stalled by a weights
# download on the first request; the router degrades to spectral cues without it.
USE_PANNS = os.environ.get("STEMFLIPPER_PANNS", "0") == "1"

_separate_fn = separate.separate_stems  # v1 hook: tests stub this


def _gpu_duration(audio_path, workdir, preset=DEFAULT_PRESET, opts=None):
    try:
        return neural.estimate_gpu_seconds(
            duration_of(audio_path), preset, bool((opts or {}).get("six"))
        )
    except Exception:
        return 180


try:
    import spaces

    gpu_stage = spaces.GPU(duration=_gpu_duration)(neural.run_neural_stage)
except Exception:  # not on Spaces: the same function runs inline on CPU/MPS
    gpu_stage = neural.run_neural_stage

if os.environ.get("SPACE_ID"):
    # Weights are placed at import, never inside the GPU window — a cold download there
    # would be charged to the caller's quota.
    neural.preload()

_HEADER = """\
# 🎛️ StemFlipper

Upload a song → it is separated into stems (and the drum kit into its own pieces) →
each stem becomes **MIDI, one-shot samples, a multisampled instrument, bar-aligned loops**
and a synth patch → download a bundle any DAW or sampler can open.

*Research/educational demo. Transcription is an editable starting point, not a finished
score. The web editor lets you mix the original stems against the reconstruction and fix
the notes before exporting.*
"""


def _prune_workdirs(ttl_h: int = WORKDIR_TTL_H) -> None:
    cutoff = time.time() - ttl_h * 3600
    for path in WORK_ROOT.glob("run_*"):
        try:
            if path.stat().st_mtime < cutoff:
                shutil.rmtree(path, ignore_errors=True)
        except OSError:
            pass


def _summary(project: dict) -> str:
    grid = project.get("grid", {})
    sep = project.get("separation", {})
    lines = [
        f"**tempo** {grid.get('tempo')} BPM · **key** {project.get('key', {}).get('name')} · "
        f"**{grid.get('time_signature')}** · **{project.get('song', {}).get('duration', 0):.0f}s** · "
        f"preset `{sep.get('preset')}`",
        "",
        "| stem | notes | engine | instrument | loops |",
        "|---|---|---|---|---|",
    ]
    for t in project.get("tracks", []):
        tr = t.get("transcription", {})
        inst = t.get("instrument", {}) or {}
        formats = [k for k in ("sampler", "sfz", "dspreset", "vital") if inst.get(k)]
        notes = "silent" if t.get("audio", {}).get("silent") else str(tr.get("n_notes", 0))
        sub = t.get("sub_stems") or []
        name = t["id"] + (f" (+{len(sub)} pieces)" if sub else "")
        lines.append(
            f"| {name} | {notes} | {tr.get('engine', '—')} | "
            f"{', '.join(formats) or '—'} | {len(t.get('loops') or [])} |"
        )
    degraded = [s for s in project.get("stages", []) if s["status"] in ("failed", "fallback")]
    if degraded:
        lines.append("")
        for s in degraded:
            lines.append(f"- `{s['name']}` **{s['status']}** — {s['detail']}")
    return "\n".join(lines)


def flip(audio_path, preset=DEFAULT_PRESET, six=False, progress=gr.Progress()):
    if not audio_path:
        raise gr.Error("Upload an audio file first.")
    try:
        seconds = duration_of(audio_path)
    except Exception as e:
        # A file the decoders cannot read at all — say so plainly instead of failing
        # later inside the GPU stage with a libsndfile message about pipes.
        raise gr.Error(f"Could not read that audio file. {e}") from e
    if seconds > MAX_AUDIO_MINUTES * 60:
        raise gr.Error(
            f"That file is {seconds / 60:.1f} minutes; please keep songs under "
            f"{MAX_AUDIO_MINUTES} minutes for this demo."
        )

    _prune_workdirs()
    workdir = Path(tempfile.mkdtemp(prefix="run_", dir=WORK_ROOT))
    stubbed = _separate_fn is not separate.separate_stems
    result = run_pipeline(
        audio_path,
        workdir,
        progress=lambda frac, desc: progress(frac, desc=desc),
        preset=preset,
        six=bool(six),
        separate_fn=_separate_fn if stubbed else None,
        neural_fn=None if stubbed else gpu_stage,
        use_panns=USE_PANNS,
    )

    bundle = Path(result["bundle_dir"])
    project = result.get("project")
    if project is None:
        project_path = bundle / "project.json"
        project = json.loads(project_path.read_text()) if project_path.exists() else {}
    # absolute root so the web app can fetch every asset through /gradio_api/file=
    project["_server"] = {"bundle_root": str(bundle.resolve())}
    return str(result["zip_path"]), project


with gr.Blocks(title="StemFlipper") as demo:
    gr.Markdown(_HEADER)
    with gr.Row():
        audio_in = gr.Audio(type="filepath", label="Song (wav/mp3/flac/m4a, ≤8 min)")
        with gr.Column():
            preset_in = gr.Dropdown(
                choices=sorted(PRESETS),
                value=DEFAULT_PRESET,
                label="Separation preset",
                info=(
                    "fast = one pass (quickest). balanced = vocal model + stems + drum-kit "
                    "split. best = same with the slower, more accurate stem model."
                ),
            )
            six_in = gr.Checkbox(
                value=False,
                label="Also split guitar & piano out of `other` (experimental — piano bleeds)",
            )
            go_btn = gr.Button("Flip it 🎚️", variant="primary")
    zip_out = gr.File(label="Bundle (.zip) — stems, MIDI, samples, instruments, loops")
    summary_out = gr.Markdown()
    editor_link = gr.Markdown()
    project_out = gr.JSON(visible=False)

    def _run(audio, preset, six, progress=gr.Progress()):
        zip_path, project = flip(audio, preset, six, progress)
        link = (
            f"▶ **[Open in the StemFlipper editor]({EDITOR_URL})** — mix the original stems "
            "against the reconstruction, fix the notes, and export MIDI and samples."
        )
        return zip_path, _summary(project), link, project

    go_btn.click(
        _run,
        inputs=[audio_in, preset_in, six_in],
        outputs=[zip_out, summary_out, editor_link, project_out],
        api_name="flip",
    )

if __name__ == "__main__":
    demo.queue(default_concurrency_limit=1).launch(
        max_file_size="40mb", allowed_paths=[str(WORK_ROOT)]
    )
