"""Version 1 manifest/job/audio HTTP API."""

from __future__ import annotations

import logging
import re
import uuid
from typing import Any, Mapping, Optional

from flask import (
    Blueprint,
    Flask,
    Response,
    current_app,
    g,
    jsonify,
    request,
    send_file,
)
from werkzeug.exceptions import HTTPException

import config
from core.contracts import (
    DURATION_TOLERANCE_MS,
    ContractValidationError,
    validate_video_key,
)
from core.storage import (
    ACTIVE_JOB_STATUSES,
    AudioInvalid,
    CatalogInvalid,
    FileRepository,
    JobInvalid,
    ManifestInvalid,
    StorageError,
)


log = logging.getLogger("soundbridge.api.v1")
bp = Blueprint("api_v1", __name__, url_prefix="/v1")
_request_id_re = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")


def _repo() -> FileRepository:
    repository = current_app.extensions.get("voice_bridge_v1_repository")
    if not isinstance(repository, FileRepository):  # pragma: no cover
        raise RuntimeError("v1 repository가 등록되지 않았습니다")
    return repository


def _request_id() -> str:
    return getattr(g, "request_id", uuid.uuid4().hex)


def _is_v1_request() -> bool:
    return request.path == "/v1" or request.path.startswith("/v1/")


def error_response(
    code: str, message: str, status: int, *, retryable: bool = False
) -> tuple[Response, int]:
    return (
        jsonify(
            {
                "error": {
                    "code": code,
                    "message": message,
                    "retryable": retryable,
                },
                "request_id": _request_id(),
            }
        ),
        status,
    )


def _public_job(
    job: Mapping[str, Any], *, manifest: Optional[Mapping[str, Any]] = None
) -> dict[str, Any]:
    """연동규격 v1.2 JobStatus 계약(contracts/job-status-v1.2.schema.json)을 그대로
    따른다 — 상태별로 정확히 그 필드만 내보낸다. FE의 실제 파서(isBackendJobStatus)는
    여분 필드를 허용하지만, JSON Schema 쪽은 additionalProperties:false라 여분
    필드가 하나라도 섞이면 "정상 응답"으로 보지 않는다(BACKEND_INTEGRATION.md 규칙 10).
    """
    status = job["status"]
    video_key = f"{job['provider']}:{job['video_id']}"

    if status == "ready":
        return {
            "status": "ready",
            "job_id": job["job_id"],
            "video_key": video_key,
            "progress_percent": 100,
            "manifest_id": manifest["manifest_id"] if manifest else job.get("manifest_id"),
            "revision": manifest["revision"] if manifest else job.get("revision"),
            "updated_at": job["updated_at"],
        }

    if status == "failed":
        error = job.get("error") if isinstance(job.get("error"), Mapping) else {}
        return {
            "status": "failed",
            "job_id": job["job_id"],
            "video_key": video_key,
            "progress_percent": job.get("progress_percent") or 0,
            "error": {
                "code": error.get("code", "UNKNOWN"),
                "retryable": bool(error.get("retryable", False)),
            },
            "updated_at": job["updated_at"],
        }

    # queued | processing
    return {
        "status": status,
        "job_id": job["job_id"],
        "video_key": video_key,
        "stage": job.get("stage") or "queued",
        "progress_percent": job.get("progress_percent") or 0,
        "eta_seconds": job.get("eta_seconds"),
        "eta_confidence": job.get("eta_confidence"),
        "retry_after_ms": config.JOB_RETRY_AFTER_MS,
        "updated_at": job["updated_at"],
    }


@bp.get("/health")
def health_v1():
    try:
        return jsonify(_repo().health_summary())
    except CatalogInvalid as exc:
        return error_response("CONFIG_INVALID", str(exc), 503, retryable=False)


@bp.get("/manifests/<provider>/<video_id>")
def manifest_get(provider: str, video_id: str):
    try:
        provider, video_id = validate_video_key(provider, video_id)
        video = _repo().get_catalog_video(provider, video_id)
    except ContractValidationError as exc:
        return error_response("INVALID_VIDEO_KEY", str(exc), 400)
    except CatalogInvalid as exc:
        return error_response("CONFIG_INVALID", str(exc), 503)

    if video is None:
        return error_response(
            "MANIFEST_NOT_FOUND", "등록되거나 처리된 영상이 아닙니다", 404
        )

    try:
        record = _repo().find_manifest(provider, video_id, video)
    except ManifestInvalid as exc:
        return error_response("MANIFEST_INVALID", str(exc), 500)

    if record is not None:
        if request.if_none_match.contains(record.etag):
            response = Response(status=304)
        else:
            response = jsonify(record.data)
        response.set_etag(record.etag, weak=False)
        response.headers["Cache-Control"] = "no-cache"
        return response

    try:
        job = _repo().latest_job_for_video(
            provider, video_id, statuses=ACTIVE_JOB_STATUSES
        )
        if job is not None:
            job = _repo().refresh_job(job["job_id"]) or job
    except (JobInvalid, StorageError) as exc:
        return error_response("JOB_STORE_ERROR", str(exc), 500, retryable=True)

    if job is not None and job["status"] in ACTIVE_JOB_STATUSES:
        # 연동규격 6.2: 202 응답도 job/status 조회와 동일한 JobStatus 본문 규격을 쓴다.
        return jsonify(_public_job(job)), 202
    if job is not None and job["status"] == "ready":
        # A manifest may have been atomically published while this request was
        # refreshing the job. Re-read once to avoid a spurious 404.
        try:
            record = _repo().find_manifest(provider, video_id, video)
        except ManifestInvalid as exc:
            return error_response("MANIFEST_INVALID", str(exc), 500)
        if record is not None:
            response = jsonify(record.data)
            response.set_etag(record.etag, weak=False)
            response.headers["Cache-Control"] = "no-cache"
            return response

    return error_response(
        "MANIFEST_NOT_FOUND", "등록되어 있지만 아직 처리 결과가 없습니다", 404
    )


@bp.post("/jobs")
def job_create():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return error_response("INVALID_REQUEST", "JSON 객체가 필요합니다", 400)
    try:
        provider, video_id = validate_video_key(
            body.get("provider"), body.get("video_id")
        )
    except ContractValidationError as exc:
        return error_response("INVALID_VIDEO_KEY", str(exc), 400)

    duration_ms = body.get("duration_ms")
    if duration_ms is not None and (
        isinstance(duration_ms, bool)
        or not isinstance(duration_ms, int)
        or duration_ms <= 0
    ):
        return error_response(
            "INVALID_REQUEST", "duration_ms는 양의 정수여야 합니다", 400
        )

    try:
        video = _repo().get_catalog_video(provider, video_id)
    except CatalogInvalid as exc:
        return error_response("CONFIG_INVALID", str(exc), 503)
    if video is None:
        return error_response(
            "VIDEO_NOT_REGISTERED", "카탈로그에 등록된 영상만 처리할 수 있습니다", 404
        )
    if (
        duration_ms is not None
        and abs(duration_ms - video.duration_ms) > DURATION_TOLERANCE_MS
    ):
        return error_response(
            "MEDIA_MISMATCH",
            f"등록된 영상 길이와 {DURATION_TOLERANCE_MS}ms 넘게 차이 납니다",
            409,
        )

    try:
        job, outcome = _repo().create_or_get_job(video)
    except ManifestInvalid as exc:
        return error_response("MANIFEST_INVALID", str(exc), 500)
    except (JobInvalid, StorageError) as exc:
        return error_response("JOB_STORE_ERROR", str(exc), 500, retryable=True)

    # 연동규격 6.2: 신규 생성 202, 즉시 준비/기존 결과 200, 동일 작업이 이미
    # 진행 중이면 409 — 모두 같은 JobStatus 본문 규격으로 반환한다.
    if outcome == "active":
        return jsonify(_public_job(job)), 409
    if outcome == "ready":
        try:
            record = _repo().find_manifest(provider, video_id, video)
        except ManifestInvalid as exc:
            return error_response("MANIFEST_INVALID", str(exc), 500)
        return jsonify(_public_job(job, manifest=record.data if record else None)), 200
    return jsonify(_public_job(job)), 202


@bp.get("/jobs/<job_id>")
def job_get(job_id: str):
    try:
        job = _repo().refresh_job(job_id)
    except ContractValidationError as exc:
        return error_response("INVALID_JOB_ID", str(exc), 400)
    except (JobInvalid, StorageError) as exc:
        return error_response("JOB_STORE_ERROR", str(exc), 500, retryable=True)
    if job is None:
        return error_response("JOB_NOT_FOUND", "작업을 찾을 수 없습니다", 404)
    manifest = None
    if job["status"] == "ready":
        try:
            record = _repo().find_manifest(job["provider"], job["video_id"])
        except ManifestInvalid:
            record = None
        manifest = record.data if record else None
    return jsonify(_public_job(job, manifest=manifest))


@bp.get("/audio/<clip_hash>.wav")
def audio_get(clip_hash: str):
    try:
        path = _repo().get_audio_path(clip_hash)
    except ContractValidationError as exc:
        return error_response("INVALID_AUDIO_HASH", str(exc), 400)
    except AudioInvalid as exc:
        return error_response("AUDIO_INVALID", str(exc), 500)
    if path is None:
        return error_response(
            "AUDIO_UNAVAILABLE", "음성 클립을 찾을 수 없습니다", 404, retryable=True
        )

    if request.if_none_match.contains(clip_hash):
        response = Response(status=304)
        response.set_etag(clip_hash, weak=False)
    else:
        response = send_file(
            path,
            mimetype="audio/wav",
            conditional=True,
            etag=clip_hash,
            max_age=31_536_000,
        )
    response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return response


@bp.errorhandler(Exception)
def api_unexpected_error(exc: Exception):
    if isinstance(exc, HTTPException):
        code = {
            400: "BAD_REQUEST",
            413: "PAYLOAD_TOO_LARGE",
            416: "RANGE_NOT_SATISFIABLE",
        }.get(exc.code or 500, "HTTP_ERROR")
        return error_response(code, exc.description, exc.code or 500)
    log.exception("v1 request failed request_id=%s", _request_id())
    return error_response(
        "INTERNAL_ERROR", "요청을 처리하는 중 내부 오류가 발생했습니다", 500, retryable=True
    )


def register_v1(app: Flask, repository: FileRepository) -> None:
    """Register v1 routes and their uniform request/error envelope."""

    app.extensions["voice_bridge_v1_repository"] = repository
    app.register_blueprint(bp)

    @app.before_request
    def api_request_id() -> None:
        if not _is_v1_request():
            return
        supplied = request.headers.get("X-Request-ID", "")
        g.request_id = supplied if _request_id_re.fullmatch(supplied) else uuid.uuid4().hex

    @app.after_request
    def api_response_headers(response: Response) -> Response:
        if _is_v1_request():
            response.headers["X-Request-ID"] = _request_id()
            log.info(
                "request_id=%s method=%s path=%s status=%s",
                _request_id(),
                request.method,
                request.path,
                response.status_code,
            )
        return response

    @app.errorhandler(404)
    def api_not_found(exc: HTTPException):
        if _is_v1_request():
            return error_response("NOT_FOUND", "API 경로를 찾을 수 없습니다", 404)
        return exc

    @app.errorhandler(405)
    def api_method_not_allowed(exc: HTTPException):
        if _is_v1_request():
            return error_response("METHOD_NOT_ALLOWED", "허용되지 않은 메서드입니다", 405)
        return exc
