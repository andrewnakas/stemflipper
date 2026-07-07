import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "tests"))

from make_fixture import build_fixture  # noqa: E402


@pytest.fixture(scope="session")
def fixture_song(tmp_path_factory):
    """Deterministic mini-song + ground truth, built once per test session."""
    return build_fixture(tmp_path_factory.mktemp("fixture_song"))
