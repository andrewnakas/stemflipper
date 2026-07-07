"""StemFlipper Gradio app — thin adapter over stemflipper.pipeline.

The same file runs locally, on a free CPU Space, and on ZeroGPU: only the
separation stage is GPU-relevant, so it alone is wrapped with @spaces.GPU
(a no-op everywhere else).
"""

import tempfile
from pathlib import Path

import gradio as gr

from stemflipper import separate
from stemflipper.audio_io import duration_of
from stemflipper.pipeline import run_pipeline

MAX_AUDIO_MINUTES = 8
PREVIEW_STEMS = ("vocals", "drums", "bass", "other")

try:
    import spaces

    _separate_fn = spaces.GPU(duration=180)(separate.separate_stems)
except Exception:
    _separate_fn = separate.separate_stems

_HEADER = """\
# 🎛️ StemFlipper

Upload a song → AI separates it into stems → each stem becomes **MIDI + a playable
sliced-sample instrument (SFZ)** → download a **DAW project bundle** (stems, MIDI,
instruments, Reaper project, manifest).

*Research/educational demo. Separation runs on CPU on this Space — a 3–4 min song takes
several minutes; the progress bar keeps moving. Transcription is an editable starting
point, not a perfect score.*
"""


def flip(audio_path, model, progress=gr.Progress()):
    if not audio_path:
        raise gr.Error("Upload an audio file first.")
    if duration_of(audio_path) > MAX_AUDIO_MINUTES * 60:
        raise gr.Error(f"Please keep songs under {MAX_AUDIO_MINUTES} minutes for this demo.")

    workdir = Path(tempfile.mkdtemp(prefix="stemflipper_"))
    result = run_pipeline(
        audio_path,
        workdir,
        model=model,
        progress=lambda frac, desc: progress(frac, desc=desc),
        separate_fn=_separate_fn,
    )
    manifest = result["manifest"]

    lines = [
        f"**tempo** {manifest['tempo']} BPM · **key** {manifest['key']} · "
        f"**duration** {manifest['duration']:.0f}s · model `{manifest['separation_model']}`",
        "",
        "| stem | notes | instrument |",
        "|---|---|---|",
    ]
    for name, meta in manifest["stems"].items():
        notes = "silent" if meta["silent"] else str(meta["n_notes"])
        sfz = "SFZ ✓" if meta["instrument_sfz"] else "—"
        lines.append(f"| {name} | {notes} | {sfz} |")
    summary = "\n".join(lines)

    bundle = result["bundle_dir"]
    previews = [
        str(bundle / "stems" / f"{name}.wav")
        if (bundle / "stems" / f"{name}.wav").exists()
        else None
        for name in PREVIEW_STEMS
    ]
    return str(result["zip_path"]), summary, *previews


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
    go_btn.click(
        flip,
        inputs=[audio_in, model_in],
        outputs=[zip_out, summary_out, *preview_outs],
        api_name="flip",
    )

if __name__ == "__main__":
    demo.queue(default_concurrency_limit=1).launch(max_file_size="30mb")
