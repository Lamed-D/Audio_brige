from __future__ import annotations

from pathlib import Path

import pytest
from flask import Flask

from api.dev import register_dev
from core.storage import FileRepository
from tests.conftest import publish_demo_manifest, write_catalog


@pytest.fixture
def repository(tmp_path: Path) -> FileRepository:
    data_dir = tmp_path / "data"
    write_catalog(data_dir)
    return FileRepository(data_dir)


@pytest.fixture
def app(repository: FileRepository) -> Flask:
    flask_app = Flask(__name__)
    flask_app.config.update(TESTING=True)

    def get_adapter():
        raise AssertionError("이미 처리된 영상이면 어댑터를 절대 부르면 안 된다 (재처리 비용 방지)")

    register_dev(flask_app, repository, get_adapter)
    return flask_app


@pytest.fixture
def client(app: Flask):
    return app.test_client()


def test_process_skips_already_processed_video_without_calling_adapter(
    client, repository, monkeypatch
):
    publish_demo_manifest(repository)

    def fail_download(*_args, **_kwargs):
        raise AssertionError("이미 처리된 영상이면 다운로드도 절대 하면 안 된다")

    monkeypatch.setattr("api.dev.download_youtube", fail_download)

    response = client.post(
        "/dev/process", json={"provider": "youtube", "video_id": "abc123"}
    )
    assert response.status_code == 200
    body = response.get_json()
    assert body["skipped_reprocessing"] is True
    assert body["manifest_id"] == "youtube:abc123:r1"
    assert body["segments_published"] == 1
