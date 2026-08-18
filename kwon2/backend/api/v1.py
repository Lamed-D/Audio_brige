"""Version 1 manifest/job/audio HTTP API."""

from __future__ import annotations

import logging
import re
import uuid
from typing import Any, Callable, Mapping, Optional

from flask import (
    Blueprint,
    Flask,
    Response,
    current_app,
    g,
    jsonify,
    request,
    send_file,
    url_for,
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


def _job_starter() -> Optional[Callable[[Mapping[str, Any]], None]]:
    return current_app.extensions.get("voice_bridge_v1_job_starter")


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


def _public_job(job: Mapping[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {
        "job_id": job["job_id"],
        "status": job["status"],
        "video_key": f"{job['provider']}:{job['video_id']}",
        "progress_percent": job.get("progress_percent", 0),
        "updated_at": job["updated_at"],
    }
    if job["status"] in ACTIVE_JOB_STATUSES:
        result.update(
            stage=job.get("stage", "queued"),
            eta_seconds=job.get("eta_seconds"),
            eta_confidence=job.get("eta_confidence"),
            retry_after_ms=config.JOB_RETRY_AFTER_MS,
        )
    elif job["status"] == "ready":
        revision = job.get("revision")
        if not isinstance(revision, int):
            revision = _repo().next_revision(job["provider"], job["video_id"]) - 1
        result["manifest_id"] = job.get("manifest_id") or (
            f"{job['provider']}:{job['video_id']}:r{revision}"
        )
        result["revision"] = revision
    elif job["status"] == "failed" and isinstance(job.get("error"), Mapping):
        result["error"] = {
            "code": str(job["error"].get("code", "PIPELINE_FAILED")),
            "retryable": bool(job["error"].get("retryable", False)),
        }
    return result


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
        if _job_starter() is not None:
            _job_starter()(job)
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
    force = body.get("force", False)
    if not isinstance(force, bool):
        return error_response(
            "INVALID_REQUEST", "force는 true 또는 false여야 합니다", 400
        )
    if force and not config.ALLOW_FORCE_REPROCESS:
        return error_response(
            "REPROCESS_DISABLED",
            "완료된 영상의 중복 처리는 서버 정책상 비활성화되어 있습니다",
            403,
        )

    try:
        video = _repo().get_catalog_video(provider, video_id)
    except CatalogInvalid as exc:
        return error_response("CONFIG_INVALID", str(exc), 503)
    if video is None:
        # 확장 프로그램은 현재 탭에서 검증한 ID와 실측 duration만 보낸다. URL 문자열을
        # 받지 않으며 provider=youtube만 허용하므로 로컬 POC에서는 첫 요청에 등록한다.
        if provider != "youtube" or duration_ms is None:
            return error_response(
                "VIDEO_NOT_REGISTERED", "처음 처리할 영상은 duration_ms가 필요합니다", 404
            )
        try:
            video = _repo().upsert_catalog_video(provider, video_id, duration_ms)
        except CatalogInvalid as exc:
            return error_response("CONFIG_INVALID", str(exc), 503)
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
        job = _repo().create_or_get_job(video, force=force)
    except ManifestInvalid as exc:
        return error_response("MANIFEST_INVALID", str(exc), 500)
    except (JobInvalid, StorageError) as exc:
        return error_response("JOB_STORE_ERROR", str(exc), 500, retryable=True)
    if job["status"] == "queued" and _job_starter() is not None:
        _job_starter()(job)
    return jsonify(_public_job(job)), (200 if job["status"] == "ready" else 202)


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
    if job["status"] in ACTIVE_JOB_STATUSES and _job_starter() is not None:
        # 개발 서버가 재시작되면 파일에는 processing 상태가 남지만 이전 워커는
        # 사라진다. 상태 조회를 재개 신호로 사용하고, starter가 중복 실행을 막는다.
        _job_starter()(job)
    return jsonify(_public_job(job))


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


def register_v1(
    app: Flask,
    repository: FileRepository,
    job_starter: Optional[Callable[[Mapping[str, Any]], None]] = None,
) -> None:
    """Register v1 routes and their uniform request/error envelope."""

    app.extensions["voice_bridge_v1_repository"] = repository
    app.extensions["voice_bridge_v1_job_starter"] = job_starter
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
