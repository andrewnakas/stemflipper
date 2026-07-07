"""Pipeline orchestrator: the one entry point the CLI, tests, and Gradio app share."""

from __future__ import annotations

import re
import shutil
from pathlib import Path

from . import (
    analyze,
    audio_io,
    effects,
    export,
    router,
    sampler,
    separate,
    synthfit,
    transcribe,
)


def run_pipeline(
    input_path: str | Path,
    output_dir: str | Path,
    model: str = separate.DEFAULT_MODEL,
    model_dir: str | Path | None = None,
    progress=None,
    make_zip: bool = True,
    separate_fn=None,
    use_panns: bool = True,
    use_synth: bool = False,
) -> dict:
    """Full flow: analyze -> separate -> route -> transcribe -> sampler -> bundle.

    separate_fn lets app.py swap in a GPU-decorated separation call (ZeroGPU);
    defaults to separate.separate_stems.
    use_panns toggles the PANNs CNN14 instrument classifier in the router (turn off
    to run fully offline; the router degrades to spectral cues either way).
    use_synth opts into the syntheon refiner for synth-fit (off by default: the Vital
    warm-start is authored with no frontier dep; syntheon is a heavy optional install).
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
    characters: dict[str, router.StemCharacter] = {}
    stem_audio_cache: dict[str, tuple] = {}  # name -> (audio, sr), reused by M5 stages
    ordered = [s for s in separate.KNOWN_STEMS if s in stem_paths]
    for i, name in enumerate(ordered):
        report(0.45 + 0.25 * i / len(ordered), f"Analyzing & transcribing {name}")
        stem_audio, stem_sr = audio_io.load_audio(stem_paths[name], mono=True)
        silent = audio_io.is_silent(stem_audio)
        stem_audio_cache[name] = (stem_audio, stem_sr)

        if silent:
            character = router.route_stem(name, stem_audio, stem_sr, [], use_panns=False)
            result = {"notes": [], "is_drum": name == "drums"}
        else:
            # route first (drums bypass instrument routing); the router's is_keys flag
            # picks the ByteDance piano transcriber over basic-pitch for keys stems.
            # PANNs runs once here (cached); the post-transcription note overlap only
            # escalates a borderline polyphony reading, no need to reclassify.
            character = router.route_stem(name, stem_audio, stem_sr, [], use_panns=use_panns)
            result = transcribe.transcribe_stem(
                name, stem_paths[name], is_keys=character.is_keys
            )
            character = router.escalate_polyphony(character, result["notes"], name)

        tracks[name] = result
        characters[name] = character
        stems_meta[name] = {
            "audio": f"stems/{name}.wav",
            "silent": silent,
            "n_notes": len(result["notes"]),
            "midi": f"midi/{name}.mid" if result["notes"] else None,
            "instrument_sfz": None,
            "instrument_vital": None,
            "effects": None,
            "strategy": character.strategy,
            "instrument": character.instrument,
            "polyphonic": character.polyphonic,
            "synth_like": character.synth_like,
            "wet": character.wet,
            "router_scores": character.scores,
        }

    # htdemucs_6s gating: the added guitar/piano stems are documented-weak (bleed) —
    # flag them so downstream (and the user) treat their transcription with suspicion.
    if model == "htdemucs_6s":
        for weak in ("piano", "guitar"):
            if weak in stems_meta:
                stems_meta[weak]["low_confidence"] = True

    for i, name in enumerate(ordered):
        report(0.7 + 0.06 * i / len(ordered), f"Building {name} instrument")
        built = sampler.build_sampler(
            name,
            stem_paths[name],
            tracks[name]["notes"],
            bundle_dir / "instruments" / name,
            is_drum=tracks[name]["is_drum"],
        )
        if built:
            stems_meta[name]["instrument_sfz"] = f"instruments/{name}/{name}.sfz"

    # --- M5: effects + synth-fit (frontier, best-effort) --------------------------
    # Every stage is wrapped so a failure only flags the stem and never blocks the
    # bundle (Invariants #4, #7). The sampler path built above is always the fallback.
    _run_effects_and_synthfit(
        ordered, characters, stem_audio_cache, stems_meta, bundle_dir, report, use_synth
    )

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


def _run_effects_and_synthfit(
    ordered, characters, stem_audio_cache, stems_meta, bundle_dir, report, use_synth
) -> None:
    """M5 stages — mutate stems_meta in place, write effects/*.json + *.vital presets.

    Best-effort: any per-stem failure just leaves that stem on the sampler path. Drums
    and silent stems are skipped (nothing to EQ-match or synth-fit).
    """
    import soundfile as sf

    fx_dir = bundle_dir / "effects"
    for i, name in enumerate(ordered):
        report(0.76 + 0.04 * i / max(1, len(ordered)), f"Reconstructing {name} effects")
        meta = stems_meta[name]
        if meta["silent"] or name == "drums":
            continue
        y, sr = stem_audio_cache.get(name, (None, None))
        if y is None:
            continue
        char = characters[name]

        # --- effects: EQ-match + blind reverb IR for every pitched, non-silent stem ---
        fx = effects.analyze_effects(y, sr, wet=char.wet)
        if fx is not None:
            fx_dir.mkdir(parents=True, exist_ok=True)
            ir_rel = None
            if fx.rt60_s > 0.0:
                ir = effects.synth_ir(fx.rt60_s, sr)
                ir_path = fx_dir / f"{name}_ir.wav"
                sf.write(str(ir_path), ir, sr)
                ir_rel = f"effects/{name}_ir.wav"
                fx.ir_wav = ir_rel
            fx_payload = {
                "eq_curve": [[f, g] for f, g in fx.eq_curve],
                "rt60_s": fx.rt60_s,
                "wet": fx.wet,
                "ir_wav": ir_rel,
                "scores": fx.scores,
            }
            (fx_dir / f"{name}.json").write_text(_json_dumps(fx_payload))
            meta["effects"] = f"effects/{name}.json"

        # --- synth-fit: only mono + synth-like stems the router selected ---
        if char.strategy == "synth-fit":
            fit = synthfit.synth_fit(y, sr, use_syntheon=use_synth)
            if fit is not None:
                vital_path = bundle_dir / "instruments" / name / f"{name}.vital"
                synthfit.write_vital(fit.preset, vital_path)
                meta["instrument_vital"] = f"instruments/{name}/{name}.vital"
                meta["synthfit"] = {
                    "waveform": fit.waveform,
                    "source": fit.source,
                    "scores": fit.scores,
                }


def _json_dumps(obj) -> str:
    import json

    return json.dumps(obj, indent=2)
