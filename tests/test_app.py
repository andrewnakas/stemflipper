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
            "fast",
            False,
            api_name="/flip",
        )
        zip_path, summary, _link, project = result
        with zipfile.ZipFile(zip_path) as zf:
            names = zf.namelist()
            assert any(n.endswith("project.json") for n in names)
            assert any(n.endswith(".sfz") for n in names)
            assert any(n.endswith(".mid") for n in names)
            assert not any(n.endswith(".RPP") for n in names), "v2 must not ship a Reaper project"
        assert "tempo" in summary

        # project.json is the contract the web app renders from
        from stemflipper.export.project_json import SCHEMA_VERSION, validate_project

        assert isinstance(project, dict)
        assert project["schema_version"] == SCHEMA_VERSION
        assert validate_project(project) == []
        assert project["_server"]["bundle_root"].startswith("/"), "asset root must be absolute"
        for track in project["tracks"]:
            for row in track["notes"]:
                assert len(row) == 5  # [pitch, start, end, velocity, confidence]
                break
    finally:
        app_module.demo.close()
