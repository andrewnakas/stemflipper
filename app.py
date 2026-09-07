"""StemFlipper Gradio app — thin adapter over stemflipper.pipeline.

The same file runs locally, on a free CPU Space, and on ZeroGPU: only the
separation stage is GPU-relevant, so it alone is wrapped with @spaces.GPU
(a no-op everywhere else).
"""

import json
import os
import tempfile
from pathlib import Path

import gradio as gr

from stemflipper import neural, separate
from stemflipper.audio_io import duration_of
from stemflipper.pipeline import run_pipeline

MAX_AUDIO_MINUTES = 8
PREVIEW_STEMS = ("vocals", "drums", "bass", "other")

# PANNs CNN14 (~340 MB) is off by default on the Space so the first request isn't stalled
# by a cold-weights download; set STEMFLIPPER_PANNS=1 (and ideally warm the cache at build)
# to enable the instrument classifier. The router degrades to spectral cues when off.
USE_PANNS = os.environ.get("STEMFLIPPER_PANNS", "0") == "1"

# ONE GPU call per song (Invariant #9). ZeroGPU bills GPU seconds and gives anonymous
# API callers only 2 minutes a day, so separation AND every neural analysis step share a
# single @spaces.GPU window whose duration is estimated from the song and preset — asking
# for a flat 180 s would burn quota and lower queue priority on short songs.
_separate_fn = separate.separate_stems  # v1 hook: tests stub this


def _gpu_duration(audio_path, workdir, preset="balanced", opts=None):
    try:
        return neural.estimate_gpu_seconds(
            duration_of(audio_path), preset, bool((opts or {}).get("six"))
        )
    except Exception:
        return 180


try:
    import spaces

    gpu_stage = spaces.GPU(duration=_gpu_duration)(neural.run_neural_stage)
except Exception:  # not on Spaces: run the same function inline (CPU/MPS)
    gpu_stage = neural.run_neural_stage

if os.environ.get("SPACE_ID"):
    # Weights are placed at import, never inside the GPU window (a cold 77 MB download
    # would be charged to the caller's quota).
    neural.preload()

_HEADER = """\
# 🎛️ StemFlipper

Upload a song → AI separates it into stems → each stem becomes **MIDI + a playable
sliced-sample instrument (SFZ)**, plus best-effort **synth presets (Vital)** for
mono synth lines and **EQ/reverb match** per stem → download a **DAW project bundle**
(stems, MIDI, instruments, effects, Reaper project, manifest).

*Research/educational demo. Separation runs on CPU on this Space — a 3–4 min song takes
several minutes; the progress bar keeps moving. Transcription is an editable starting
point, not a perfect score.*
"""


def _rt60_of(bundle, effects_rel):
    """Read the reverb RT60 from a stem's effects json (0.0/absent if dry). Best-effort."""
    import json

    try:
        fx = json.loads((Path(bundle) / effects_rel).read_text())
        return fx.get("rt60_s") or 0.0
    except Exception:
        return 0.0


def flip(audio_path, model, progress=gr.Progress()):
    if not audio_path:
        raise gr.Error("Upload an audio file first.")
    if duration_of(audio_path) > MAX_AUDIO_MINUTES * 60:
        raise gr.Error(f"Please keep songs under {MAX_AUDIO_MINUTES} minutes for this demo.")

    workdir = Path(tempfile.mkdtemp(prefix="stemflipper_"))
    # A test (or any caller) that stubs _separate_fn wins over the GPU stage, so the
    # round-trip suite never needs a model download.
    stubbed = _separate_fn is not separate.separate_stems
    result = run_pipeline(
        audio_path,
        workdir,
        model=model,
        progress=lambda frac, desc: progress(frac, desc=desc),
        separate_fn=_separate_fn if stubbed else None,
        neural_fn=None if stubbed else gpu_stage,
        use_panns=USE_PANNS,
    )
    manifest = result["manifest"]
    bundle = result["bundle_dir"]

    lines = [
        f"**tempo** {manifest['tempo']} BPM · **key** {manifest['key']} · "
        f"**duration** {manifest['duration']:.0f}s · model `{manifest['separation_model']}`",
        "",
        "| stem | instrument | notes | strategy | SFZ | Vital | FX |",
        "|---|---|---|---|---|---|---|",
    ]
    for name, meta in manifest["stems"].items():
        notes = "silent" if meta["silent"] else str(meta["n_notes"])
        sfz = "✓" if meta["instrument_sfz"] else "—"
        vital = "✓" if meta.get("instrument_vital") else "—"
        # FX cell: reverb RT60 (if any) from the effects json reference, EQ always present
        fx = "—"
        if meta.get("effects"):
            fx = "EQ"
            rt60 = _rt60_of(bundle, meta["effects"])
            if rt60:
                fx += f" · rev {rt60:.1f}s"
        inst = meta.get("instrument", "—")
        strat = meta.get("strategy", "—")
        if meta.get("low_confidence"):
            strat += " ⚠️"
        lines.append(f"| {name} | {inst} | {notes} | {strat} | {sfz} | {vital} | {fx} |")
    summary = "\n".join(lines)

    previews = [
        str(bundle / "stems" / f"{name}.wav")
        if (bundle / "stems" / f"{name}.wav").exists()
        else None
        for name in PREVIEW_STEMS
    ]

    # Per-stem detected notes for the client piano-roll (appended LAST so the preview
    # output indices above stay stable for existing API callers).
    notes_path = bundle / "notes.json"
    notes = json.loads(notes_path.read_text()) if notes_path.exists() else {"stems": {}}

    return str(result["zip_path"]), summary, *previews, notes


with gr.Blocks(title="StemFlipper") as demo:
    gr.Markdown(_HEADER)
    with gr.Row():
        audio_in = gr.Audio(type="filepath", label="Song (wav/mp3/flac/m4a, ≤8 min)")
        with gr.Column():
            model_in = gr.Dropdown(
                choices=list(separate.MODELS),
                value=separate.DEFAULT_MODEL,
                label="Separation model",
                info="htdemucs = 4 stems (default). htdemucs_6s adds guitar+piano (piano is weak).",
            )
            go_btn = gr.Button("Flip it 🎚️", variant="primary")
    zip_out = gr.File(label="DAW project bundle (.zip)")
    summary_out = gr.Markdown()
    with gr.Row():
        preview_outs = [
            gr.Audio(label=name, interactive=False) for name in PREVIEW_STEMS
        ]
    # Per-stem detected notes → the static web frontend draws piano-rolls from this.
    # Hidden in the Gradio UI itself (visible=False) but present in the API output.
    notes_out = gr.JSON(visible=False)
    go_btn.click(
        flip,
        inputs=[audio_in, model_in],
        outputs=[zip_out, summary_out, *preview_outs, notes_out],
        api_name="flip",
    )

if __name__ == "__main__":
    demo.queue(default_concurrency_limit=1).launch(max_file_size="30mb")
