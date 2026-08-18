from __future__ import annotations

import json


def assert_error(response, status: int, code: str):
    assert response.status_code == status
    payload = response.get_json()
    assert payload["error"]["code"] == code
    assert isinstance(payload["error"]["message"], str)
    assert isinstance(payload["error"]["retryable"], bool)
    assert payload["request_id"] == response.headers["X-Request-ID"]


def test_health_does_not_require_model_adapter(client):
    response = client.get("/v1/health")
    assert response.status_code == 200
    assert response.get_json() == {
        "status": "ok",
        "schema_version": "1.0",
        "catalog_videos": 1,
        "manifest_files": 0,
    }


def test_manifest_not_found_uses_standard_error(client):
    response = client.get("/v1/manifests/youtube/abc123")
    assert_error(response, 404, "MANIFEST_NOT_FOUND")


def test_unknown_video_cannot_create_job(client):
    response = client.post(
        "/v1/jobs",
        json={"provider": "youtube", "video_id": "not-registered"},
    )
    assert_error(response, 404, "VIDEO_NOT_REGISTERED")


def test_job_is_idempotent_and_manifest_endpoint_reports_processing(client):
    payload = {"provider": "youtube", "video_id": "abc123", "duration_ms": 20_000}
    first = client.post("/v1/jobs", json=payload)
    second = client.post("/v1/jobs", json=payload)
    assert first.status_code == second.status_code == 202
    assert first.get_json()["job_id"] == second.get_json()["job_id"]
    assert first.get_json()["status"] == "queued"

    status = client.get(f"/v1/jobs/{first.get_json()['job_id']}")
    assert status.status_code == 200
    assert status.get_json()["status"] == "queued"
    pending = client.get("/v1/manifests/youtube/abc123")
    assert pending.status_code == 202
    assert pending.get_json()["job_id"] == first.get_json()["job_id"]


def test_job_becomes_ready_when_manifest_is_published(client, publish):
    created = client.post(
        "/v1/jobs", json={"provider": "youtube", "video_id": "abc123"}
    ).get_json()
    publish()

    status = client.get(f"/v1/jobs/{created['job_id']}")
    assert status.status_code == 200
    assert status.get_json()["status"] == "ready"
    assert status.get_json()["manifest_path"] == "/v1/manifests/youtube/abc123"


def test_ready_job_fails_if_published_manifest_disappears(client, repository, publish):
    created = client.post(
        "/v1/jobs", json={"provider": "youtube", "video_id": "abc123"}
    ).get_json()
    publish()
    assert client.get(f"/v1/jobs/{created['job_id']}").get_json()["status"] == "ready"

    (repository.manifests_dir / "youtube" / "abc123.json").unlink()
    response = client.get(f"/v1/jobs/{created['job_id']}")
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["status"] == "failed"
    assert payload["error"]["code"] == "MANIFEST_NOT_FOUND"


def test_manifest_etag_and_audio_immutable_cache(client, publish):
    manifest, clip_hash, wav_bytes = publish()
    response = client.get("/v1/manifests/youtube/abc123")
    assert response.status_code == 200
    assert response.get_json() == manifest
    assert response.headers["Cache-Control"] == "no-cache"
    etag = response.headers["ETag"]

    unchanged = client.get(
        "/v1/manifests/youtube/abc123", headers={"If-None-Match": etag}
    )
    assert unchanged.status_code == 304
    assert unchanged.data == b""
    assert unchanged.headers["ETag"] == etag

    audio = client.get(f"/v1/audio/{clip_hash}.wav")
    assert audio.status_code == 200
    assert audio.data == wav_bytes
    assert audio.mimetype == "audio/wav"
    assert audio.headers["Cache-Control"] == "public, max-age=31536000, immutable"
    assert audio.headers["ETag"] == f'"{clip_hash}"'


def test_duration_mismatch_is_rejected(client):
    response = client.post(
        "/v1/jobs",
        json={"provider": "youtube", "video_id": "abc123", "duration_ms": 25_000},
    )
    assert_error(response, 409, "MEDIA_MISMATCH")


def test_bad_manifest_fails_closed(client, repository, publish):
    manifest, _, _ = publish()
    manifest["segments"][0]["audio"]["duration_ms"] = 999
    path = repository.manifests_dir / "youtube" / "abc123.json"
    path.write_text(json.dumps(manifest), encoding="utf-8")
    response = client.get("/v1/manifests/youtube/abc123")
    assert_error(response, 500, "MANIFEST_INVALID")


def test_request_id_is_preserved_and_unknown_v1_paths_are_json(client):
    response = client.get(
        "/v1/does-not-exist", headers={"X-Request-ID": "contract-test-123"}
    )
    assert_error(response, 404, "NOT_FOUND")
    assert response.headers["X-Request-ID"] == "contract-test-123"

    root = client.get("/v1")
    assert_error(root, 404, "NOT_FOUND")


def test_invalid_hash_and_missing_audio_are_distinct(client):
    invalid = client.get("/v1/audio/not-a-hash.wav")
    assert_error(invalid, 400, "INVALID_AUDIO_HASH")
    missing = client.get(f"/v1/audio/{'f' * 64}.wav")
    assert_error(missing, 404, "AUDIO_UNAVAILABLE")


def test_audio_bytes_must_match_hash(client, repository, publish):
    _, clip_hash, _ = publish()
    (repository.audio_dir / f"{clip_hash}.wav").write_bytes(b"changed")
    response = client.get(f"/v1/audio/{clip_hash}.wav")
    assert_error(response, 500, "AUDIO_INVALID")
