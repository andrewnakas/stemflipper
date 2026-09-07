"""The one GPU stage.

ZeroGPU bills GPU time per call and anonymous callers get 2 minutes a day, so every model
that wants a GPU runs inside a SINGLE ``@spaces.GPU`` function (Invariant #9): separation
chain first, then the neural analysis/transcription that benefits from the same GPU.

Everything here must be safe on CPU and MPS too (tests, CI, `python app.py` on a laptop),
and must return only picklable values — the decorated call runs in a forked worker, so
model objects created inside it do not survive.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from pathlib import Path

from . import audio_io
from .analysis import beats as beats_mod
from .separation import PRESETS, separate_hierarchical

log = logging.getLogger(__name__)

#: Rough GPU seconds per minute of audio, per preset. Re-measured from live runs in P6
#: and used by app.py to request a ZeroGPU duration that is neither short (job killed)
#: nor wasteful (quota burned, queue priority lowered).
GPU_COST = {"fast": 4.0, "balanced": 12.0, "best": 18.0}
GPU_FIXED_S = 15.0
GPU_SIX_EXTRA = 4.0


@dataclass
class NeuralOutputs:
    """Everything the GPU stage produced. Paths, not objects (forked-worker safe)."""

    stems: dict[str, Path] = field(default_factory=dict)
    drum_sub: dict[str, Path] = field(default_factory=dict)
    chain: list[dict] = field(default_factory=list)
    residual_db: float = -120.0
    beats: list[float] = field(default_factory=list)
    downbeats: list[float] = field(default_factory=list)
    beats_source: str = "none"
    #: per-stem f0 tracks from RMVPE (P2): {stem: {"f0": [...], "conf": [...], "hop_s": float}}
    f0: dict[str, dict] = field(default_factory=dict)
    #: per-stem note lists from GPU transcribers, e.g. ByteDance piano (P2)
    notes: dict[str, list] = field(default_factory=dict)
    device: str = "cpu"
    seconds: float = 0.0
    errors: dict[str, str] = field(default_factory=dict)


def pick_device() -> str:
    """cuda (ZeroGPU / any CUDA box) -> mps (Apple Silicon) -> cpu."""
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"


def estimate_gpu_seconds(duration_s: float, preset: str = "balanced", six: bool = False) -> int:
    """ZeroGPU duration request for a song. Clamped to a sane band."""
    minutes = max(0.25, min(float(duration_s) / 60.0, 8.0))
    per_min = GPU_COST.get(preset, GPU_COST["balanced"]) + (GPU_SIX_EXTRA if six else 0.0)
    return int(max(30, min(GPU_FIXED_S + per_min * minutes, 240)))


def run_neural_stage(
    input_path: str | Path,
    workdir: str | Path,
    preset: str = "balanced",
    opts: dict | None = None,
) -> NeuralOutputs:
    """Separation + neural analysis in one GPU window.

    Every sub-stage is independently best-effort: a failure is recorded in ``errors`` and
    the pipeline degrades (Invariant #4), but separation failing is fatal — there is no
    song without stems.
    """
    opts = dict(opts or {})
    input_path = Path(input_path)
    workdir = Path(workdir)
    stems_dir = workdir / "stems"
    device = opts.get("device") or pick_device()
    t0 = time.perf_counter()

    out = NeuralOutputs(device=device)

    sep = separate_hierarchical(
        input_path,
        stems_dir,
        preset if preset in PRESETS else "balanced",
        six=bool(opts.get("six")),
        model_dir=opts.get("model_dir"),
        progress=opts.get("progress"),
    )
    out.stems = sep.stems
    out.drum_sub = sep.drum_sub
    out.chain = sep.chain
    out.residual_db = sep.residual_db

    # --- beat + downbeat tracking ------------------------------------------------
    if opts.get("beats", True):
        try:
            mix, sr = audio_io.load_stereo(input_path)
            out.beats, out.downbeats, out.beats_source, detail = beats_mod.best_grid(
                mix, sr, device=device
            )
            if out.beats_source != "beat_this":
                out.errors["beats"] = detail
        except Exception as e:
            log.warning("beat tracking failed: %s", e)
            out.errors["beats"] = str(e)

    out.seconds = round(time.perf_counter() - t0, 2)
    return out


def neural_from_separate_fn(separate_fn):
    """Adapt a v1-style ``separate_fn(input, out_dir, model=, model_dir=)`` into a neural
    stage, so existing tests (and any caller that stubs separation) keep working."""

    def _stage(input_path, workdir, preset="balanced", opts=None):
        opts = dict(opts or {})
        stems_dir = Path(workdir) / "stems"
        stems_dir.mkdir(parents=True, exist_ok=True)
        raw = separate_fn(
            Path(input_path), stems_dir, model=opts.get("model"), model_dir=opts.get("model_dir")
        )
        stems: dict[str, Path] = {}
        for name, path in raw.items():
            target = stems_dir / f"{name}.wav"
            path = Path(path)
            if path != target:
                if target.exists():
                    target.unlink()
                path.rename(target)
            stems[name] = target
        out = NeuralOutputs(
            stems=stems,
            chain=[{"step": "stems", "model": str(opts.get("model") or "stub"),
                    "input": Path(input_path).stem, "seconds": 0.0}],
            device="cpu",
        )
        if opts.get("beats", True):
            try:
                mix, sr = audio_io.load_stereo(input_path)
                out.beats, out.downbeats = beats_mod.librosa_beats(mix, sr)
                out.beats_source = "librosa"
            except Exception as e:
                out.errors["beats"] = str(e)
        return out

    return _stage


def preload(preset: str = "balanced", device: str | None = None) -> None:
    """Warm model weights at import time on the Space.

    ZeroGPU runs a CUDA emulation outside @spaces.GPU precisely so weights can be placed
    at import; downloading a 77 MB checkpoint inside the GPU window would burn the user's
    quota on network I/O. Best-effort: never raise at import.
    """
    device = device or pick_device()
    try:
        from .separation import registry

        for key in PRESETS.get(preset, ()):  # resolve names now (network) not later
            registry.resolve(key)
    except Exception as e:
        log.warning("model registry preload failed: %s", e)
    try:
        if beats_mod.available():
            beats_mod._get_model("final0", "cpu")
    except Exception as e:
        log.warning("beat_this preload failed: %s", e)
