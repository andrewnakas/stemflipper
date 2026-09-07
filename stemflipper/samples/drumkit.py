"""Build a playable drum kit of one-shots from the separated kit pieces.

v1 emitted at most three WAVs for a whole song (the single loudest kick, snare and hat).
This builds a real kit: per piece, several velocity layers with round-robin variations,
each one an isolated, trimmed, normalised one-shot.
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

from .. import audio_io
from ..transcription import drums as drums_mod
from . import hits as hits_mod

log = logging.getLogger(__name__)

MAX_LAYERS = 3
MAX_ROUND_ROBIN = 4
_MIN_HITS_FOR_LAYERS = 6


def _velocity_layers(peaks_db: list[float], max_layers: int = MAX_LAYERS) -> list[tuple[int, int]]:
    """Split the dynamic range into (lovel, hivel) bands, one per layer."""
    if len(peaks_db) < _MIN_HITS_FOR_LAYERS:
        return [(0, 127)]
    spread = float(np.percentile(peaks_db, 95) - np.percentile(peaks_db, 5))
    layers = 1 if spread < 6.0 else (2 if spread < 14.0 else max_layers)
    if layers == 1:
        return [(0, 127)]
    edges = np.linspace(0, 127, layers + 1).astype(int)
    return [(int(edges[i]) + (1 if i else 0), int(edges[i + 1])) for i in range(layers)]


def build_kit(
    sub_stems: dict[str, Path],
    notes: list[dict],
    out_dir: str | Path,
    stem_path: str | Path | None = None,
) -> dict | None:
    """Write instruments/drums/{samples/*.wav, kit.json}; return the kit dict or None."""
    out_dir = Path(out_dir)
    samples_dir = out_dir / "samples"

    onsets_by_piece: dict[str, list[float]] = {}
    audio_by_piece: dict[str, tuple] = {}
    if sub_stems:
        for piece, path in sub_stems.items():
            if piece == "drums_other":
                continue
            try:
                y, sr = audio_io.load_audio(path, mono=True)
            except Exception:
                continue
            if not len(y) or float(np.abs(y).max()) < 1e-4:
                continue
            audio_by_piece[piece] = (y, sr)
        present = drums_mod._present_pieces(audio_by_piece)
        for piece, (y, sr) in present.items():
            params = drums_mod.PIECE_PARAMS.get(piece, drums_mod._DEFAULT_PARAMS)
            times, _, _, _ = drums_mod._onsets(y, sr, params["delta"], params["wait_s"])
            onsets_by_piece[piece] = [float(t) for t in times]
        audio_by_piece = present

    if not audio_by_piece:
        return _build_kit_from_notes(notes, stem_path, out_dir)

    # Peak level of each individual HIT, so isolation compares like with like. Comparing
    # whole-piece peaks is too blunt: on the fixture the snare and hat peaks sat 5.9 dB
    # under the kick — just inside a 6 dB margin — so every one of the 16 kicks was
    # rejected as contaminated and the kit shipped without a kick at all.
    hit_levels: dict[str, dict[float, float]] = {}
    for piece, (y, sr) in audio_by_piece.items():
        params = drums_mod.PIECE_PARAMS.get(piece, drums_mod._DEFAULT_PARAMS)
        win = int(params["window_s"] * sr)
        levels = {}
        for t in onsets_by_piece.get(piece, []):
            a = int(t * sr)
            seg = y[a : a + win]
            peak = float(np.abs(seg).max()) if len(seg) else 0.0
            levels[round(float(t), 4)] = 20 * np.log10(max(peak, 1e-9))
        hit_levels[piece] = levels

    pieces: dict[str, dict] = {}
    for piece, (y, sr) in audio_by_piece.items():
        times = onsets_by_piece.get(piece, [])
        if not times:
            continue
        params = drums_mod.PIECE_PARAMS.get(piece, drums_mod._DEFAULT_PARAMS)
        window = params["max_len_s"]

        candidates = []
        for i, t in enumerate(times):
            nxt = times[i + 1] if i + 1 < len(times) else None
            if not hits_mod.is_isolated_hit(
                t, onsets_by_piece, hit_levels, piece,
                window_s=min(window, 0.12),
                self_level_db=hit_levels.get(piece, {}).get(round(float(t), 4), 0.0),
            ):
                continue
            audio = hits_mod.extract_hit(y, sr, t, nxt, max_len_s=window)
            if audio is None:
                continue
            raw_peak = float(np.abs(y[int(t * sr) : int((t + window) * sr)]).max() or 1e-9)
            candidates.append({"audio": audio, "peak_db": 20 * np.log10(raw_peak), "sr": sr})
        if not candidates:
            continue

        peaks = [c["peak_db"] for c in candidates]
        bands = _velocity_layers(peaks)
        lo_db, hi_db = float(np.percentile(peaks, 5)), float(np.percentile(peaks, 95))
        span = max(hi_db - lo_db, 1e-6)

        zones = []
        for layer_i, (lovel, hivel) in enumerate(bands):
            in_band = [
                c for c in candidates
                if lovel <= np.clip(127 * (c["peak_db"] - lo_db) / span, 0, 127) <= hivel
            ]
            if not in_band:
                continue
            for rr, cand in enumerate(hits_mod.dedupe(in_band, sr)[:MAX_ROUND_ROBIN]):
                name = f"{piece}_v{layer_i + 1}_rr{rr + 1}.wav"
                audio_io.write_wav24(samples_dir / name, cand["audio"], sr)
                zones.append({
                    "path": f"instruments/drums/samples/{name}",
                    "lovel": int(lovel), "hivel": int(hivel), "rr": rr,
                })
        if zones:
            gm_map = {
                "kick": [drums_mod.GM_KICK], "snare": [drums_mod.GM_SNARE],
                "toms": [drums_mod.GM_TOM_LOW, drums_mod.GM_TOM_MID, drums_mod.GM_TOM_HIGH],
                "hh": [drums_mod.GM_HAT, drums_mod.GM_HAT_OPEN],
                "ride": [drums_mod.GM_RIDE], "crash": [drums_mod.GM_CRASH, drums_mod.GM_CRASH_2],
            }
            gm = gm_map.get(piece, [drums_mod.GM_SNARE])[0]
            pieces[piece] = {"gm": gm, "gm_all": gm_map.get(piece, [gm]), "zones": zones}

    if not pieces:
        return _build_kit_from_notes(notes, stem_path, out_dir)
    return {"type": "drumkit", "name": "drums", "pieces": pieces}


def _build_kit_from_notes(notes, stem_path, out_dir: Path) -> dict | None:
    """Fallback when the kit was not split: one one-shot per GM pitch from the mixed stem."""
    if not notes or stem_path is None:
        return None
    try:
        y, sr = audio_io.load_audio(stem_path, mono=True)
    except Exception:
        return None
    samples_dir = out_dir / "samples"
    by_pitch: dict[int, dict] = {}
    for n in notes:
        cur = by_pitch.get(n["pitch"])
        if cur is None or n["velocity"] > cur["velocity"]:
            by_pitch[n["pitch"]] = n

    pieces: dict[str, dict] = {}
    for pitch, note in sorted(by_pitch.items()):
        audio = hits_mod.extract_hit(y, sr, note["start"], max_len_s=1.0)
        if audio is None:
            continue
        name = f"gm{pitch:03d}_v1_rr1.wav"
        audio_io.write_wav24(samples_dir / name, audio, sr)
        pieces[f"gm{pitch}"] = {
            "gm": int(pitch), "gm_all": [int(pitch)],
            "zones": [{"path": f"instruments/drums/samples/{name}", "lovel": 0, "hivel": 127, "rr": 0}],
        }
    if not pieces:
        return None
    return {"type": "drumkit", "name": "drums", "pieces": pieces}
