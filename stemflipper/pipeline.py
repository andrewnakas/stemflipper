"""Pipeline orchestrator: the one entry point the CLI, tests, and Gradio app share."""

from __future__ import annotations

import re
import shutil
from pathlib import Path

from . import analyze, audio_io, export, sampler, separate, transcribe


def run_pipeline(
    input_path: str | Path,
    output_dir: str | Path,
    model: str = separate.DEFAULT_MODEL,
    model_dir: str | Path | None = None,
    progress=None,
    make_zip: bool = True,
    separate_fn=None,
) -> dict:
    """Full flow: analyze -> separate -> transcribe -> sampler -> bundle.

    separate_fn lets app.py swap in a GPU-decorated separation call (ZeroGPU);
    defaults to separate.separate_stems.
    Returns {"bundle_dir", "zip_path", "manifest"}.
    """

    def report(frac: float, desc: str) -> None:
        if progress is not None:
            progress(frac, desc)

    input_path = Path(input_path)
    slug = re.sub(r"[^\w-]+", "_", input_path.stem).strip("_") or "song"
    bundle_dir = Path(output_dir) / slug
    if bundle_dir.exists():
        shutil.rmtree(bundle_dir)
    stems_dir = bundle_dir / "stems"
    stems_dir.mkdir(parents=True)

    report(0.02, "Loading audio")
    y, sr = audio_io.load_audio(input_path, mono=True)

    report(0.05, "Analyzing tempo & key")
    analysis = analyze.analyze_audio(y, sr)

    report(0.12, f"Separating stems ({model}) — the slow part")
    do_separate = separate_fn or separate.separate_stems
    raw_stems = do_separate(input_path, stems_dir, model=model, model_dir=model_dir)

    # normalize to stems/<name>.wav
    stem_paths: dict[str, Path] = {}
    for name, path in raw_stems.items():
        target = stems_dir / f"{name}.wav"
        if path != target:
            path.rename(target)
        stem_paths[name] = target

    tracks: dict[str, dict] = {}
    stems_meta: dict[str, dict] = {}
    ordered = [s for s in separate.KNOWN_STEMS if s in stem_paths]
    for i, name in enumerate(ordered):
        report(0.55 + 0.25 * i / len(ordered), f"Transcribing {name}")
        stem_audio, stem_sr = audio_io.load_audio(stem_paths[name], mono=True)
        silent = audio_io.is_silent(stem_audio)
        result = (
            {"notes": [], "is_drum": name == "drums"}
            if silent
            else transcribe.transcribe_stem(name, stem_paths[name])
        )
        tracks[name] = result
        stems_meta[name] = {
            "audio": f"stems/{name}.wav",
            "silent": silent,
            "n_notes": len(result["notes"]),
            "midi": f"midi/{name}.mid" if result["notes"] else None,
            "instrument_sfz": None,
        }

    for i, name in enumerate(ordered):
        report(0.8 + 0.08 * i / len(ordered), f"Building {name} instrument")
        built = sampler.build_sampler(
            name,
            stem_paths[name],
            tracks[name]["notes"],
            bundle_dir / "instruments" / name,
            is_drum=tracks[name]["is_drum"],
        )
        if built:
            stems_meta[name]["instrument_sfz"] = f"instruments/{name}/{name}.sfz"

    report(0.9, "Writing MIDI, manifest, Reaper project")
    export.write_midi(tracks, analysis.tempo, bundle_dir / "midi")
    manifest = export.make_manifest_meta(input_path.name, analysis, model, stems_meta)
    export.write_manifest(bundle_dir, manifest)
    export.write_readme(bundle_dir, input_path.name, analysis)
    export.write_rpp(
        bundle_dir,
        analysis.tempo,
        {n: m["audio"] for n, m in stems_meta.items()},
        analysis.duration,
    )

    zip_path = None
    if make_zip:
        report(0.96, "Zipping bundle")
        zip_path = export.zip_bundle(bundle_dir)

    report(1.0, "Done")
    return {"bundle_dir": bundle_dir, "zip_path": zip_path, "manifest": manifest}
