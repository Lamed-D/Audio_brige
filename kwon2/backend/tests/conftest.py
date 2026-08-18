from __future__ import annotations

import hashlib
import io
import json
import wave
from pathlib import Path

import pytest
from flask import Flask

from api.v1 import register_v1
from core.storage import FileRepository


DEMO_VIDEO = {
    "provider": "youtube",
    "video_id": "abc123",
    "duration_ms": 20_000,
    "enabled": True,
}


def write_catalog(root: Path, videos: list[dict] | None = None) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "catalog.json").write_text(
        json.dumps(
            {"schema_version": "1.0", "videos": videos or [DEMO_VIDEO]},
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def make_wav(duration_ms: int = 125, sample_rate: int = 24_000) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(b"\x00\x00" * round(duration_ms * sample_rate / 1000))
    return output.getvalue()


def publish_demo_manifest(
    repository: FileRepository,
    *,
    revision: int = 1,
) -> tuple[dict, str, bytes]:
    wav_bytes = make_wav()
    clip_hash = hashlib.sha256(wav_bytes).hexdigest()
    (repository.audio_dir / f"{clip_hash}.wav").write_bytes(wav_bytes)
    manifest = {
        "schema_version": "1.1",
        "manifest_id": f"youtube:abc123:r{revision}",
        "revision": revision,
        "video": {
            "provider": "youtube",
            "video_id": "abc123",
            "duration_ms": 20_000,
        },
        "voice": {
            "voice_id": "ko-KR-poc",
            "format": "audio/wav",
            "sample_rate_hz": 24_000,
        },
        "playback": {
            "duck_factor": 0.35,
            "preload_count": 3,
            "lookahead_ms": 500,
            "late_tolerance_ms": 250,
            "auto_pause_default": True,
            "max_extended_duration_ms": 8_000,
            "min_extended_interval_ms": 15_000,
        },
        "segments": [
            {
                "id": "seg-001",
                "mode": "overlay",
                "trigger_ms": 1_000,
                "deadline_ms": 1_500,
                "text": "화면에 표가 나타난다",
                "importance": "normal",
                "source": "vlm",
                "confidence": "high",
                "audio": {
                    "path": f"/v1/audio/{clip_hash}.wav",
                    "duration_ms": 125,
                    "sha256": clip_hash,
                },
            }
        ],
    }
    manifest_dir = repository.manifests_dir / "youtube"
    manifest_dir.mkdir(parents=True, exist_ok=True)
    repository.publish_manifest(manifest)
    return manifest, clip_hash, wav_bytes


@pytest.fixture
def repository(tmp_path: Path) -> FileRepository:
    data_dir = tmp_path / "data"
    write_catalog(data_dir)
    return FileRepository(data_dir)


@pytest.fixture
def app(repository: FileRepository) -> Flask:
    flask_app = Flask(__name__)
    flask_app.config.update(TESTING=True)
    register_v1(flask_app, repository)
    return flask_app


@pytest.fixture
def client(app: Flask):
    return app.test_client()


@pytest.fixture
def publish(repository: FileRepository):
    def _publish(**kwargs):
        return publish_demo_manifest(repository, **kwargs)

    return _publish

