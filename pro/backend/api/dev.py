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
from core.storage import CatalogInvalid, FileRepository, ManifestInvalid
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

    repository = _repo()
    adapter, adapter_error = _adapter_provider()()
    if adapter is None:
        return _error("ADAPTER_UNAVAILABLE", adapter_error or "어댑터를 사용할 수 없습니다", 503)

    with tempfile.TemporaryDirectory(prefix="soundbridge_dev_process_") as tmp_dir:
        video_path = str(Path(tmp_dir) / f"{uuid.uuid4().hex}.mp4")
        log.info("dev/process: 다운로드 시작 provider=%s video_id=%s", provider, video_id)
        try:
            download_youtube(video_id, video_path)
        except Exception as exc:  # noqa: BLE001 - yt-dlp 예외를 하나의 실패 코드로 정리한다
            log.warning("dev/process: 다운로드 실패: %s", exc)
            return _error("DOWNLOAD_FAILED", str(exc), 502)

        # 카탈로그 등록(처음 보는 video_id면 실측 길이로 자동 등록)은 run_pipeline
        # 안에서 처리한다 — 오디오 추출을 두 번 하지 않기 위해서다.
        log.info("dev/process: 파이프라인 시작")
        try:
            result = run_pipeline(
                provider, video_id, video_path, repository, adapter, language=language
            )
        except (PipelineError, CatalogInvalid, ManifestInvalid, ContractValidationError) as exc:
            log.warning("dev/process: 파이프라인 실패: %s", exc)
            return _error("PIPELINE_FAILED", str(exc), 500)

    return jsonify(
        {
            "manifest_id": result["manifest"]["manifest_id"],
            "duration_ms": result["manifest"]["video"]["duration_ms"],
            "gaps_total": result["gaps_total"],
            "segments_published": result["segments_published"],
            "segments_skipped": result["segments_skipped"],
        }
    )


def register_dev(app: Flask, repository: FileRepository, get_adapter: AdapterProvider) -> None:
    app.extensions["voice_bridge_dev_repository"] = repository
    app.extensions["voice_bridge_dev_get_adapter"] = get_adapter
    app.register_blueprint(bp)
