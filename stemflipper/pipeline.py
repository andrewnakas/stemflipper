"""Pipeline orchestrator: the one entry point the CLI, tests, and Gradio app share.

v2 shape: a single neural (GPU) stage produces stems + beat grid, then per-stem CPU work
runs on top. Every stage is wrapped by ``_run_stage`` so a degraded run is *visible* in
project.json instead of silently producing an empty bundle (Invariant #7).
"""

from __future__ import annotations

import logging
import re
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path

from . import (
    analyze,
    audio_io,
    cleanup,
    effects,
    export,
    neural as neural_mod,
    quantize,
    router,
    sampler,
    separate,
    synthfit,
    transcribe,
)
from . import samples as samples_mod
from .analysis import chords as chords_mod
from .analysis import grid as grid_mod
from .analysis import sections as sections_mod
from .export import project_json
from .samples.writers import write_dspreset, write_instrument_json, write_sfz
from .separation import DEFAULT_PRESET, PRESETS

log = logging.getLogger(__name__)

#: v1 --model values map onto v2 presets so old commands and API calls keep working.
MODEL_ALIASES = {"htdemucs": "fast", "htdemucs_ft": "best", "htdemucs_6s": "best"}


@dataclass
class StageResult:
    name: str
    status: str = "ok"
    seconds: float = 0.0
    detail: str = ""

    def to_dict(self) -> dict:
        return project_json.stage(self.name, self.status, self.seconds, self.detail)


@dataclass
class StageLog:
    stages: list[StageResult] = field(default_factory=list)

    def run(self, name: str, fn, *, fallback=None, detail: str = "", required: bool = False):
        """Run a stage, recording status+timing. Returns (value, StageResult).

        A non-required stage that raises degrades to `fallback` and is marked "failed"
        rather than aborting the bundle; a required stage re-raises.
        """
        t0 = time.perf_counter()
        try:
            value = fn()
            status = "ok"
        except Exception as e:
            if required:
                raise
            log.exception("stage %s failed", name)
            value, status, detail = fallback, "failed", f"{type(e).__name__}: {e}"
        result = StageResult(name, status, round(time.perf_counter() - t0, 2), detail)
        self.stages.append(result)
        return value, result

    def note(self, name: str, status: str, detail: str = "", seconds: float = 0.0) -> None:
        self.stages.append(StageResult(name, status, round(seconds, 2), detail))

    def mark(self, name: str, status: str, detail: str = "") -> None:
        """Amend the most recent stage with the given name (e.g. ok -> fallback)."""
        for result in reversed(self.stages):
            if result.name == name:
                result.status = status
                if detail:
                    result.detail = detail
                return
        self.note(name, status, detail)

    def to_list(self) -> list[dict]:
        return [s.to_dict() for s in self.stages]


def resolve_preset(preset: str | None, model: str | None) -> str:
    if preset:
        return preset if preset in PRESETS else DEFAULT_PRESET
    if model:
        return MODEL_ALIASES.get(model, DEFAULT_PRESET)
    return DEFAULT_PRESET


def run_pipeline(
    input_path: str | Path,
    output_dir: str | Path,
    model: str | None = None,
    model_dir: str | Path | None = None,
    progress=None,
    make_zip: bool = True,
    separate_fn=None,
    use_panns: bool = True,
    use_synth: bool = False,
    *,
    preset: str | None = None,
    six: bool = False,
    neural_fn=None,
    workers: int = 3,
) -> dict:
    """Full flow: neural stage (separation + beats) -> per-stem work -> bundle.

    `neural_fn` lets app.py inject the @spaces.GPU-wrapped stage; `separate_fn` is the v1
    escape hatch (tests stub separation with it) and is adapted automatically.
    Returns {"bundle_dir", "zip_path", "manifest", "project"}.
    """

    def report(frac: float, desc: str) -> None:
        if progress is not None:
            progress(frac, desc)

    input_path = Path(input_path)
    preset = resolve_preset(preset, model)
    six = six or model == "htdemucs_6s"
    slug = re.sub(r"[^\w-]+", "_", input_path.stem).strip("_") or "song"
    bundle_dir = Path(output_dir) / slug
    if bundle_dir.exists():
        shutil.rmtree(bundle_dir)
    stems_dir = bundle_dir / "stems"
    stems_dir.mkdir(parents=True)

    stage_log = StageLog()

    report(0.02, "Loading audio")
    y, sr = audio_io.load_audio(input_path, mono=True)
    duration = len(y) / sr

    # --- neural stage: separation (+ beat grid), one GPU window -------------------
    report(0.08, f"Separating stems ({preset}) — the slow part")
    if neural_fn is None:
        neural_fn = (
            neural_mod.neural_from_separate_fn(separate_fn)
            if separate_fn is not None
            else neural_mod.run_neural_stage
        )
    opts = {"six": six, "model_dir": model_dir, "model": model}
    neural, _ = stage_log.run(
        "separate",
        lambda: neural_fn(input_path, bundle_dir, preset, opts),
        detail=preset,
        required=True,
    )
    stage_log.mark("separate", "ok", f"{preset}: {', '.join(c['step'] for c in neural.chain)}")

    stem_paths: dict[str, Path] = {}
    for name, path in neural.stems.items():
        target = stems_dir / f"{name}.wav"
        path = Path(path)
        if path != target:
            if target.exists():
                target.unlink()
            path.rename(target)
        stem_paths[name] = target

    # --- musical grid -------------------------------------------------------------
    report(0.42, "Analyzing tempo, key & chords")
    analysis = analyze.analyze_audio(y, sr)
    if neural.beats:
        grid = grid_mod.build_grid(
            neural.beats, neural.downbeats, duration, analysis.tempo, source=neural.beats_source
        )
        detail = f"{neural.beats_source}: {len(grid.beats)} beats, {len(grid.downbeats)} downbeats"
        if neural.errors.get("beats"):
            detail += f" ({neural.errors['beats']})"
        stage_log.note("beats", "ok" if neural.beats_source == "beat_this" else "fallback", detail)
    else:
        grid = grid_mod.build_grid(analysis.beat_times, [], duration, analysis.tempo, source="librosa")
        stage_log.note("beats", "fallback", "librosa (no neural beats)")
    # keep the v1 Analysis in sync so every downstream writer sees the better grid
    analysis.tempo = grid.tempo
    analysis.beat_times = grid.beats
    analysis.time_signature = grid.time_signature

    chords, _ = stage_log.run(
        "chords", lambda: chords_mod.estimate_chords(y, sr, grid.beats), fallback=[]
    )
    sections, _ = stage_log.run(
        "sections",
        lambda: sections_mod.estimate_sections(y, sr, grid.downbeats, duration),
        fallback=[],
    )

    # --- per-stem: route -> transcribe -> clean -> quantize ------------------------
    tracks: dict[str, dict] = {}
    stems_meta: dict[str, dict] = {}
    characters: dict[str, router.StemCharacter] = {}
    stem_audio_cache: dict[str, tuple] = {}
    ordered = [s for s in separate.KNOWN_STEMS if s in stem_paths]
    ordered += [s for s in stem_paths if s not in ordered]

    def _process_stem(name: str) -> tuple[str, dict, object, bool, tuple]:
        """Route -> transcribe -> clean -> quantize for one stem (thread-safe)."""
        stem_audio, stem_sr = audio_io.load_audio(stem_paths[name], mono=True)
        silent = audio_io.is_silent(stem_audio)

        if silent:
            character = router.route_stem(name, stem_audio, stem_sr, [], use_panns=False)
            result = {"notes": [], "is_drum": name == "drums", "engine": "silent",
                      "fallback": None}
        else:
            character = router.route_stem(name, stem_audio, stem_sr, [], use_panns=use_panns)
            result = transcribe.transcribe_track(
                name,
                stem_paths[name],
                y=stem_audio,
                sr=stem_sr,
                character=character,
                sub_stems=(neural.drum_sub if name == "drums" else None),
                device=getattr(neural, "device", "cpu"),
            )
            character = router.escalate_polyphony(character, result["notes"], name)

        if result["notes"]:
            try:
                result["notes"] = cleanup.clean_notes(
                    result["notes"], is_drum=result.get("is_drum", False)
                )
            except Exception:
                log.exception("cleanup failed for %s", name)
            if grid.beats:
                try:
                    result["notes"] = quantize.quantize_notes(result["notes"], grid.beats, duration)
                except Exception:
                    log.exception("quantize failed for %s", name)
        return name, result, character, silent, (stem_audio, stem_sr)

    # Per-stem work is CPU-bound but dominated by native code that releases the GIL
    # (librosa, onnxruntime), so a small thread pool is a real speedup on a 6-stem song.
    # workers=1 keeps test output deterministic.
    processed: dict[str, tuple] = {}
    if workers > 1 and len(ordered) > 1:
        from concurrent.futures import ThreadPoolExecutor

        with ThreadPoolExecutor(max_workers=min(workers, len(ordered))) as pool:
            for i, out in enumerate(pool.map(_process_stem, ordered)):
                processed[out[0]] = out
                report(0.45 + 0.25 * (i + 1) / len(ordered), f"Transcribed {out[0]}")
    else:
        for i, name in enumerate(ordered):
            report(0.45 + 0.25 * i / max(1, len(ordered)), f"Analyzing & transcribing {name}")
            processed[name] = _process_stem(name)

    for name in ordered:
        _, result, character, silent, audio = processed[name]
        stem_audio_cache[name] = audio
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
    engines = ", ".join(
        f"{n}={t.get('engine', '?')}" for n, t in tracks.items() if not t.get("engine") == "silent"
    )
    stage_log.note(
        "transcribe", "ok",
        f"{sum(len(t['notes']) for t in tracks.values())} notes across {len(tracks)} stems ({engines})",
    )

    if six:
        for weak in ("piano", "guitar"):
            if weak in stems_meta:
                stems_meta[weak]["low_confidence"] = True

    instruments: dict[str, dict] = {}
    loops: dict[str, list] = {}
    phrases: dict[str, list] = {}
    for i, name in enumerate(ordered):
        report(0.7 + 0.10 * i / max(1, len(ordered)), f"Building {name} samples")
        meta = stems_meta[name]
        result = tracks[name]
        char = characters[name]
        stem_audio, stem_sr = stem_audio_cache[name]
        inst_dir = bundle_dir / "instruments" / name

        instrument = None
        try:
            if result["is_drum"]:
                instrument = samples_mod.build_kit(
                    neural.drum_sub, result["notes"], inst_dir, stem_paths[name]
                )
            elif result["notes"] and not meta["silent"]:
                instrument = samples_mod.build_multisample(
                    name, stem_audio, stem_sr, result["notes"], inst_dir,
                    sustained=bool(getattr(char, "synth_like", False))
                    or float(char.scores.get("sustain", 0.0)) >= 0.6,
                )
        except Exception:
            log.exception("sample extraction failed for %s", name)

        if instrument is None and result["notes"]:
            # last resort: the v1 one-slice-per-pitch sampler, so a stem is never left
            # with no playable instrument at all (Invariant #4)
            try:
                if sampler.build_sampler(
                    name, stem_paths[name], result["notes"], inst_dir,
                    is_drum=result["is_drum"],
                ):
                    meta["instrument_sfz"] = f"instruments/{name}/{name}.sfz"
            except Exception:
                log.exception("legacy sampler failed for %s", name)
        elif instrument is not None:
            instruments[name] = instrument
            kind = "kit" if instrument["type"] == "drumkit" else "instrument"
            write_instrument_json(instrument, inst_dir / f"{kind}.json")
            write_sfz(instrument, inst_dir / f"{name}.sfz")
            write_dspreset(instrument, inst_dir / f"{name}.dspreset")
            meta["instrument_sampler"] = f"instruments/{name}/{kind}.json"
            meta["instrument_sfz"] = f"instruments/{name}/{name}.sfz"
            meta["instrument_dspreset"] = f"instruments/{name}/{name}.dspreset"

        # loops + phrases from the stem audio itself
        if not meta["silent"]:
            try:
                loops[name] = samples_mod.extract_loops(
                    name, stem_audio, stem_sr, grid, bundle_dir / "loops",
                    key=analysis.key, sections=sections,
                )
            except Exception:
                log.exception("loop extraction failed for %s", name)
            if name == "vocals" and result["notes"]:
                try:
                    phrases[name] = samples_mod.chop_phrases(
                        name, stem_audio, stem_sr, result["notes"], bundle_dir / "phrases"
                    )
                except Exception:
                    log.exception("phrase chopping failed for %s", name)

    n_zones = sum(
        len(inst.get("zones", [])) + sum(len(p["zones"]) for p in inst.get("pieces", {}).values())
        for inst in instruments.values()
    )
    stage_log.note(
        "instruments", "ok",
        f"{len(instruments)} instruments, {n_zones} zones, "
        f"{sum(len(v) for v in loops.values())} loops, {sum(len(v) for v in phrases.values())} phrases",
    )

    _run_effects_and_synthfit(
        ordered, characters, stem_audio_cache, stems_meta, bundle_dir, report, use_synth
    )
    stage_log.note("effects", "ok", f"{sum(1 for m in stems_meta.values() if m['effects'])} analyzed")

    report(0.9, "Writing MIDI, manifest, DAW projects")
    midi_written = export.write_midi(
        tracks, grid, bundle_dir / "midi", chords=chords, sections=sections
    )
    export.write_notes(
        tracks, duration, bundle_dir,
        tempo=grid.tempo, beat_times=grid.beats, time_signature=grid.time_signature,
    )
    for name, meta in stems_meta.items():
        meta["notes"] = "notes.json" if tracks.get(name, {}).get("notes") else None

    # No Reaper .RPP in v2: it carried only a tempo and audio-file references, and the
    # MIDI + DAWproject below cover every DAW (DAWproject runs before the FLAC conversion
    # because it bundles the stem audio into its own zip).
    stem_audio_map = {n: m["audio"] for n, m in stems_meta.items()}
    dawproject, _ = stage_log.run(
        "dawproject",
        lambda: export.write_dawproject(
            tracks, stem_audio_map, grid.tempo, grid.time_signature, duration, bundle_dir
        ) and "project.dawproject",
        fallback=None,
    )

    manifest = export.make_manifest_meta(input_path.name, analysis, preset, stems_meta)
    manifest["dawproject"] = dawproject
    manifest["preset"] = preset
    export.write_manifest(bundle_dir, manifest)
    export.write_readme(bundle_dir, input_path.name, analysis)

    # Stems become FLAC now that every stage that reads them is done; the chain
    # intermediates go too. project.json is written afterwards so its paths are right.
    export.cleanup_workdirs(bundle_dir)
    flac_map, _ = stage_log.run("bundle", lambda: export.stems_to_flac(bundle_dir), fallback={})
    for name, meta in stems_meta.items():
        rel = (flac_map or {}).get(name)
        if rel:
            meta["audio"] = rel

    project, _ = stage_log.run(
        "project",
        lambda: _build_project(
            input_path, duration, sr, grid, analysis, chords, sections, preset, neural,
            ordered, stems_meta, tracks, characters, dawproject, bundle_dir,
            loops, phrases, midi_written,
        ),
        fallback=None,
    )
    if project is not None:
        project["stages"] = stage_log.to_list()
        project_json.write_project(bundle_dir, project)

    zip_path = None
    if make_zip:
        report(0.96, "Zipping bundle")
        zip_path = export.zip_bundle(bundle_dir)

    report(1.0, "Done")
    return {
        "bundle_dir": bundle_dir,
        "zip_path": zip_path,
        "manifest": manifest,
        "project": project,
    }


def _build_project(
    input_path, duration, sr, grid, analysis, chords, sections, preset, neural,
    ordered, stems_meta, tracks, characters, dawproject, bundle_dir,
    loops=None, phrases=None, midi_written=None,
) -> dict:
    """Assemble project.json — the browser's whole view of the song."""
    drum_sub_meta: dict[str, list] = {}
    for piece, path in (neural.drum_sub or {}).items():
        stem = Path(path).stem
        rel = f"stems/drums/{stem}.flac"
        if not (Path(bundle_dir) / rel).exists():
            rel = f"stems/drums/{Path(path).name}"
        drum_sub_meta.setdefault("drums", []).append(
            {"id": piece, "src": rel, "gm": _GM_FOR_PIECE.get(piece, [])}
        )

    entries = []
    for name in ordered:
        meta = stems_meta[name]
        result = tracks[name]
        char = characters[name]
        fx = None
        if meta.get("effects"):
            fx = _effects_payload(bundle_dir, meta["effects"])
        entries.append(
            project_json.track_entry(
                name,
                audio={
                    "src": meta["audio"],
                    "silent": meta["silent"],
                    "peak_db": None,
                    "lufs": None,
                },
                notes=result["notes"],
                kind="drums" if result["is_drum"] else "pitched",
                sub_stems=drum_sub_meta.get(name, []),
                character={
                    "strategy": char.strategy,
                    "instrument": char.instrument,
                    "polyphonic": char.polyphonic,
                    "synth_like": char.synth_like,
                    "wet": char.wet,
                    "low_confidence": bool(meta.get("low_confidence")),
                    "scores": char.scores,
                },
                transcription={
                    "engine": result.get("engine", "basic_pitch"),
                    "fallback": result.get("fallback"),
                    "n_notes": len(result["notes"]),
                    "quantized": bool(grid.beats),
                    "subdivision": 4,
                },
                instrument={
                    "sampler": meta.get("instrument_sampler"),
                    "sfz": meta.get("instrument_sfz"),
                    "dspreset": meta.get("instrument_dspreset"),
                    "patch": meta.get("instrument_patch"),
                    "vital": meta.get("instrument_vital"),
                },
                effects=fx,
                loops=(loops or {}).get(name, []),
                phrases=(phrases or {}).get(name, []),
                midi=meta.get("midi"),
            )
        )

    return project_json.build_project(
        source_file=input_path.name,
        duration=duration,
        sample_rate=sr,
        grid=grid.to_dict(),
        key={"name": analysis.key, "tonic": None, "mode": None, "confidence": 0.0},
        chords=chords or [],
        sections=sections or [],
        separation={
            "preset": preset,
            "device": neural.device,
            "gpu_seconds": neural.seconds,
            "residual_db": neural.residual_db,
            "chain": neural.chain,
        },
        tracks=entries,
        midi={
            "song": "midi/song.mid" if (midi_written or {}).get("song") else None,
            "chords": "midi/chords.mid" if (midi_written or {}).get("chords") else None,
        },
        exports={"dawproject": dawproject, "readme": "README.txt"},
    )


_GM_FOR_PIECE = {
    "kick": [36], "snare": [38], "toms": [45, 47, 50],
    "hh": [42, 46], "ride": [51], "crash": [49, 57], "drums_other": [],
}


def _effects_payload(bundle_dir: Path, rel: str) -> dict | None:
    import json

    try:
        fx = json.loads((Path(bundle_dir) / rel).read_text())
    except Exception:
        return None
    return {
        "eq": {
            "bands": [
                {"type": "peaking", "freq": f, "gain_db": g, "q": 1.0}
                for f, g in fx.get("eq_curve", [])
            ],
            "match_bands": None,
        },
        "reverb": {
            "rt60_s": fx.get("rt60_s", 0.0),
            "wet": bool(fx.get("wet")),
            "ir": fx.get("ir_wav"),
            "mix": 0.2 if fx.get("wet") else 0.0,
        },
    }


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
