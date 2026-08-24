"""Local-only convenience API: register a catalog entry and run the full
M1~M5 pipeline in one HTTP call.

This is deliberately NOT part of /v1. The public API only ever reads
pre-registered, pre-processed data (core/storage.py, api/v1.py) and never
triggers a download or a paid model call on request — that boundary is the
whole point of the "no arbitrary URL collection" rule in the spec. This
blueprint exists purely so a developer testing locally (backend/static/test.html)
doesn't have to shell out to pipeline/build_manifest.py by hand. It downloads
real video and calls real paid APIs, so config.DEV_PIPELINE_API_ENABLED must be
explicitly kept on, and this must never be exposed outside 127.0.0.1.
"""

from __future__ import annotations

import logging
import tempfile
import uuid
from pathlib import Path
from typing import Callable, Optional, Tuple

from flask import Blueprint, Flask, current_app, jsonify, request

from adapters.base import ModelAdapter
from core.contracts import ContractValidationError, validate_video_key
from core.storage import CatalogInvalid, FileRepository, JobInvalid, ManifestInvalid, StorageError
from pipeline.build_manifest import PipelineError, run_pipeline
from pipeline.fetch_youtube import download_youtube

log = logging.getLogger("soundbridge.api.dev")
bp = Blueprint("api_dev", __name__, url_prefix="/dev")

AdapterProvider = Callable[[], Tuple[Optional[ModelAdapter], Optional[str]]]


def _repo() -> FileRepository:
    repository = current_app.extensions.get("voice_bridge_dev_repository")
    if not isinstance(repository, FileRepository):  # pragma: no cover
        raise RuntimeError("dev repository가 등록되지 않았습니다")
    return repository


def _adapter_provider() -> AdapterProvider:
    provider = current_app.extensions.get("voice_bridge_dev_get_adapter")
    if provider is None:  # pragma: no cover
        raise RuntimeError("dev adapter provider가 등록되지 않았습니다")
    return provider


def _error(code: str, message: str, status: int):
    return jsonify({"error": {"code": code, "message": message, "retryable": False}}), status


def _fail_job_safely(repository: FileRepository, job_id: Optional[str], code: str, message: str) -> None:
    """job_id가 있으면 job을 failed로 확정한다 — 없으면 조용히 넘어간다.

    이게 없으면 job을 만들어 둔 채 파이프라인이 죽었을 때 그 job이 영영
    processing에 멈춰서, 폴링하는 클라이언트가 끝나지 않는 작업을 계속
    기다리게 된다."""
    if job_id is None:
        return
    try:
        repository.fail_job(job_id, code=code, message=message, retryable=False)
    except (JobInvalid, StorageError) as exc:  # noqa: BLE001 - 실패 기록 실패로 원래 오류 응답을 가리면 안 된다
        log.warning("dev/process: job 실패 기록 실패: %s", exc)


@bp.post("/process")
def process():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return _error("INVALID_REQUEST", "JSON 객체가 필요합니다", 400)

    try:
        provider, video_id = validate_video_key(body.get("provider"), body.get("video_id"))
    except ContractValidationError as exc:
        return _error("INVALID_VIDEO_KEY", str(exc), 400)

    if provider != "youtube":
        return _error(
            "UNSUPPORTED_PROVIDER",
            "자동 다운로드는 provider=youtube 만 지원합니다. 다른 소스는 "
            "pipeline/build_manifest.py --video 로 로컬 파일을 직접 지정하세요",
            400,
        )

    language = body.get("language") or "ko"
    if not isinstance(language, str):
        return _error("INVALID_REQUEST", "language는 문자열이어야 합니다", 400)

    force = bool(body.get("force"))

    repository = _repo()

    try:
        existing_video = repository.get_catalog_video(provider, video_id)
    except CatalogInvalid:
        existing_video = None

    # 이미 처리된 영상은 다시 다운로드·과금 API를 호출하지 않는다 — 게시된
    # manifest 자체가 "이미 처리됨"의 기록이라 별도 DB 없이도 재처리 여부를
    # 판단할 수 있다. --force(또는 body.force)를 명시해야만 다시 돈다.
    if existing_video is not None and not force:
        try:
            existing_record = repository.find_manifest(provider, video_id, existing_video)
        except ManifestInvalid:
            existing_record = None
        if existing_record is not None:
            log.info("dev/process: 이미 처리됨, 재처리 skip (force=true로 강제 가능)")
            return jsonify(
                {
                    "manifest_id": existing_record.data["manifest_id"],
                    "duration_ms": existing_record.data["video"]["duration_ms"],
                    "segments_published": len(existing_record.data["segments"]),
                    "skipped_reprocessing": True,
                }
            )

    adapter, adapter_error = _adapter_provider()()
    if adapter is None:
        return _error("ADAPTER_UNAVAILABLE", adapter_error or "어댑터를 사용할 수 없습니다", 503)

    # 이미 카탈로그에 등록된 영상이면 job 을 먼저 만들어서, 이 동기 요청이 끝나기
    # 전이라도 다른 클라이언트가 GET /v1/jobs/{job_id} 로 실시간 진행률(연동규격
    # 6.3)을 폴링할 수 있게 한다. 처음 보는 video_id 는 이 시점엔 duration_ms 를
    # 몰라 job 을 만들 수 없다 — run_pipeline 이 실측 후 자동 등록한다.
    job_id = None
    if existing_video is not None:
        try:
            job, _outcome = repository.create_or_get_job(existing_video)
            job_id = job["job_id"]
        except (ManifestInvalid, JobInvalid, StorageError):
            job_id = None

    def progress_cb(stage: str, percent: int, eta_seconds, eta_confidence) -> None:
        if job_id is None:
            return
        try:
            repository.update_job_progress(
                job_id,
                stage=stage,
                progress_percent=percent,
                eta_seconds=eta_seconds,
                eta_confidence=eta_confidence,
            )
        except (JobInvalid, StorageError) as exc:  # noqa: BLE001 - 진행률 기록 실패로 파이프라인을 멈추지 않는다
            log.warning("dev/process: 진행률 기록 실패: %s", exc)

    with tempfile.TemporaryDirectory(prefix="soundbridge_dev_process_") as tmp_dir:
        video_path = str(Path(tmp_dir) / f"{uuid.uuid4().hex}.mp4")
        log.info("dev/process: 다운로드 시작 provider=%s video_id=%s", provider, video_id)
        try:
            download_youtube(video_id, video_path)
        except Exception as exc:  # noqa: BLE001 - yt-dlp 예외를 하나의 실패 코드로 정리한다
            log.warning("dev/process: 다운로드 실패: %s", exc)
            _fail_job_safely(repository, job_id, "DOWNLOAD_FAILED", str(exc))
            return _error("DOWNLOAD_FAILED", str(exc), 502)

        # 카탈로그 등록(처음 보는 video_id면 실측 길이로 자동 등록)은 run_pipeline
        # 안에서 처리한다 — 오디오 추출을 두 번 하지 않기 위해서다.
        log.info("dev/process: 파이프라인 시작")
        try:
            result = run_pipeline(
                provider,
                video_id,
                video_path,
                repository,
                adapter,
                language=language,
                progress_cb=progress_cb if job_id else None,
            )
        except (PipelineError, CatalogInvalid, ManifestInvalid, ContractValidationError) as exc:
            log.warning("dev/process: 파이프라인 실패: %s", exc)
            _fail_job_safely(repository, job_id, "PIPELINE_FAILED", str(exc))
            return _error("PIPELINE_FAILED", str(exc), 500)

    return jsonify(
        {
            "manifest_id": result["manifest"]["manifest_id"],
            "duration_ms": result["manifest"]["video"]["duration_ms"],
            "gaps_total": result["gaps_total"],
            "segments_published": result["segments_published"],
            "segments_skipped": result["segments_skipped"],
            "job_id": job_id,
        }
    )


def register_dev(app: Flask, repository: FileRepository, get_adapter: AdapterProvider) -> None:
    app.extensions["voice_bridge_dev_repository"] = repository
    app.extensions["voice_bridge_dev_get_adapter"] = get_adapter
    app.register_blueprint(bp)
