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
        "schema_version": "1.1",
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


def test_job_create_is_202_then_409_while_active(client):
    """연동규격 6.2: 신규 생성은 202, 동일 작업이 이미 진행 중이면 409."""
    payload = {"provider": "youtube", "video_id": "abc123", "duration_ms": 20_000}
    first = client.post("/v1/jobs", json=payload)
    assert first.status_code == 202
    body = first.get_json()
    assert body["status"] == "queued"
    assert body["stage"] == "queued"
    assert body["progress_percent"] == 0
    assert body["video_key"] == "youtube:abc123"
    # FE contracts/job-status-v1.2.schema.json은 queued/processing에 이 필드만
    # 허용한다(unevaluatedProperties:false) — video/created_at 같은 여분 필드가
    # 섞이면 FE JSON Schema 검증 기준을 위반한다.
    assert set(body.keys()) == {
        "status", "job_id", "video_key", "stage", "progress_percent",
        "eta_seconds", "eta_confidence", "retry_after_ms", "updated_at",
    }

    second = client.post("/v1/jobs", json=payload)
    assert second.status_code == 409
    assert second.get_json()["job_id"] == body["job_id"]

    status = client.get(f"/v1/jobs/{body['job_id']}")
    assert status.status_code == 200
    assert status.get_json()["status"] == "queued"
    pending = client.get("/v1/manifests/youtube/abc123")
    assert pending.status_code == 202
    assert pending.get_json()["job_id"] == body["job_id"]
    assert pending.get_json()["stage"] == "queued"


def test_job_progress_is_monotonic_and_visible_before_ready(client, repository):
    payload = {"provider": "youtube", "video_id": "abc123", "duration_ms": 20_000}
    job_id = client.post("/v1/jobs", json=payload).get_json()["job_id"]

    repository.update_job_progress(
        job_id, stage="audio_analysis", progress_percent=20, eta_seconds=40, eta_confidence="low"
    )
    repository.update_job_progress(
        job_id, stage="visual_analysis", progress_percent=10, eta_seconds=None, eta_confidence=None
    )

    status = client.get(f"/v1/jobs/{job_id}").get_json()
    assert status["status"] == "processing"
    # 감소하는 진행률 업데이트가 와도 이전 최대값 아래로 내려가지 않는다.
    assert status["progress_percent"] == 20
    assert status["stage"] == "visual_analysis"


def test_job_becomes_ready_when_manifest_is_published(client, publish):
    created = client.post(
        "/v1/jobs", json={"provider": "youtube", "video_id": "abc123"}
    ).get_json()
    publish()

    status = client.get(f"/v1/jobs/{created['job_id']}")
    assert status.status_code == 200
    body = status.get_json()
    assert body["status"] == "ready"
    assert body["progress_percent"] == 100
    assert body["manifest_id"] == "youtube:abc123:r1"
    assert body["revision"] == 1
    # 연동규격 v1.2 JobStatus 계약(FE contracts/job-status-v1.2.schema.json)에
    # 없는 필드는 절대 섞이지 않는다 — additionalProperties:false로 강제된다.
    assert set(body.keys()) == {
        "status", "job_id", "video_key", "progress_percent", "manifest_id", "revision", "updated_at",
    }


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
    # FE의 isBackendJobStatus()는 failed에도 progress_percent(정수)와
    # error.retryable(boolean)을 반드시 요구한다 — 없으면 응답 전체를
    # invalid_response로 버린다.
    assert isinstance(payload["progress_percent"], int)
    assert payload["error"]["retryable"] is False
    assert set(payload.keys()) == {"status", "job_id", "video_key", "progress_percent", "error", "updated_at"}
    assert set(payload["error"].keys()) == {"code", "retryable"}


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
