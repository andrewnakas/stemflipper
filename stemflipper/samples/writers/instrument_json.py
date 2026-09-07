"""instrument.json / kit.json — the contract the browser sampler plays from."""

from __future__ import annotations

import json
from pathlib import Path


def write_instrument_json(instrument: dict, path: str | Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(instrument, indent=2))
    return path
