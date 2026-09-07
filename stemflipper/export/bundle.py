"""Bundle assembly: convert stems to FLAC, write the folder guide, zip it.

Stems ship as 24-bit FLAC — about half the size of WAV with no quality loss, and every
browser decodes it, which matters because the web app streams every stem to play the
Original lane alongside the reconstruction. Samples and loops stay WAV: that is what
samplers and DAWs import without complaint.
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path

from .. import audio_io

log = logging.getLogger(__name__)


def stems_to_flac(bundle_dir: str | Path, bits: int = 24) -> dict[str, str]:
    """Replace stems/*.wav with FLAC. Returns {stem_name: new relative path}."""
    bundle_dir = Path(bundle_dir)
    stems_dir = bundle_dir / "stems"
    if not stems_dir.exists():
        return {}
    out: dict[str, str] = {}
    for wav in sorted(stems_dir.rglob("*.wav")):
        try:
            y, sr = audio_io.load_stereo(wav)
            flac = wav.with_suffix(".flac")
            audio_io.write_flac(flac, y, sr, bits=bits)
            wav.unlink()
            rel = flac.relative_to(bundle_dir).as_posix()
            out[flac.stem] = rel
        except Exception:
            log.exception("could not convert %s to FLAC — leaving the WAV", wav)
            out[wav.stem] = wav.relative_to(bundle_dir).as_posix()
    return out


def cleanup_workdirs(bundle_dir: str | Path) -> None:
    """Remove separation intermediates — they are large and reproducible."""
    chain = Path(bundle_dir) / "stems" / "_chain"
    if chain.exists():
        shutil.rmtree(chain, ignore_errors=True)


def zip_bundle(bundle_dir: str | Path) -> Path:
    bundle_dir = Path(bundle_dir)
    archive = shutil.make_archive(
        str(bundle_dir), "zip", root_dir=str(bundle_dir.parent), base_dir=bundle_dir.name
    )
    return Path(archive)
