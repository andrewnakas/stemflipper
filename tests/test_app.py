"""M2 gate: gradio_client round trip against the local app with stubbed separation."""

import zipfile

import pytest

from test_pipeline import _fake_separator


@pytest.fixture(scope="module")
def app_module():
    import app

    return app


def test_app_roundtrip(app_module, fixture_song, monkeypatch):
    from gradio_client import Client, handle_file

    monkeypatch.setattr(app_module, "_separate_fn", _fake_separator(fixture_song))
    app_module.demo.queue(default_concurrency_limit=1)
    _, url, _ = app_module.demo.launch(
        prevent_thread_lock=True, quiet=True, show_error=True
    )
    try:
        client = Client(url, verbose=False)
        result = client.predict(
            handle_file(str(fixture_song["paths"]["mix"])),
            "htdemucs",
            api_name="/flip",
        )
        zip_path, summary = result[0], result[1]
        with zipfile.ZipFile(zip_path) as zf:
            names = zf.namelist()
            assert any(n.endswith("manifest.json") for n in names)
            assert any(n.endswith(".sfz") for n in names)
            assert any(n.endswith("notes.json") for n in names)
        assert "tempo" in summary
        # last output = per-stem notes for the web piano-roll
        notes = result[-1]
        assert isinstance(notes, dict) and "stems" in notes
        for stem in notes["stems"].values():
            for row in stem["notes"]:
                assert len(row) == 4  # [pitch, start, end, velocity]
                break
    finally:
        app_module.demo.close()
