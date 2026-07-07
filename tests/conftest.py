import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "tests"))

from make_fixture import build_fixture, build_router_fixtures  # noqa: E402


@pytest.fixture(scope="session")
def fixture_song(tmp_path_factory):
    """Deterministic mini-song + ground truth, built once per test session."""
    return build_fixture(tmp_path_factory.mktemp("fixture_song"))


@pytest.fixture(scope="session")
def router_fixtures(tmp_path_factory):
    """Three single-instrument stems (mono_synth / mono_acoustic / poly_chord) that
    exercise the router's three reconstruction routes. Built once per session."""
    return build_router_fixtures(tmp_path_factory.mktemp("router_fixtures"))
