"""Public v1 API contract validation.

The browser extension must be able to trust a manifest without making any
additional timing or safety decisions.  This module therefore deliberately
keeps validation independent from Flask and from model-provider adapters.
"""

from __future__ import annotations

import math
import re
from typing import Any, Mapping, Optional


SCHEMA_VERSION = "1.1"
DURATION_TOLERANCE_MS = 1_000

PROVIDER_RE = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
CLIP_HASH_RE = re.compile(r"^[0-9a-f]{64}$")


class ContractValidationError(ValueError):
    """Raised when public data does not satisfy schema version 1.0."""

    def __init__(self, message: str, field: Optional[str] = None):
        self.field = field
        prefix = f"{field}: " if field else ""
        super().__init__(prefix + message)


def validate_video_key(provider: Any, video_id: Any) -> tuple[str, str]:
    if not isinstance(provider, str) or not PROVIDER_RE.fullmatch(provider):
        raise ContractValidationError(
            "소문자 영문으로 시작하고 영문·숫자·_·-만 사용할 수 있습니다",
            "provider",
        )
    if not isinstance(video_id, str) or not VIDEO_ID_RE.fullmatch(video_id):
        raise ContractValidationError(
            "영문·숫자·_·-로 된 1~128자 값이어야 합니다",
            "video_id",
        )
    return provider, video_id


def validate_clip_hash(value: Any, field: str = "clip_hash") -> str:
    if not isinstance(value, str) or not CLIP_HASH_RE.fullmatch(value):
        raise ContractValidationError("64자리 소문자 SHA-256이어야 합니다", field)
    return value


def _mapping(value: Any, field: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ContractValidationError("객체여야 합니다", field)
    return value


def _string(
    obj: Mapping[str, Any],
    key: str,
    field: str,
    *,
    nonempty: bool = True,
) -> str:
    value = obj.get(key)
    if not isinstance(value, str) or (nonempty and not value.strip()):
        raise ContractValidationError("비어 있지 않은 문자열이어야 합니다", field)
    return value


def _integer(
    obj: Mapping[str, Any],
    key: str,
    field: str,
    *,
    minimum: Optional[int] = None,
) -> int:
    value = obj.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ContractValidationError("정수 밀리초 값이어야 합니다", field)
    if minimum is not None and value < minimum:
        raise ContractValidationError(f"{minimum} 이상이어야 합니다", field)
    return value


def _number(
    obj: Mapping[str, Any],
    key: str,
    field: str,
    *,
    minimum: Optional[float] = None,
    maximum: Optional[float] = None,
) -> float:
    value = obj.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ContractValidationError("숫자여야 합니다", field)
    number = float(value)
    if not math.isfinite(number):
        raise ContractValidationError("유한한 숫자여야 합니다", field)
    if minimum is not None and number < minimum:
        raise ContractValidationError(f"{minimum} 이상이어야 합니다", field)
    if maximum is not None and number > maximum:
        raise ContractValidationError(f"{maximum} 이하여야 합니다", field)
    return number


def validate_manifest(
    value: Any,
    *,
    expected_provider: Optional[str] = None,
    expected_video_id: Optional[str] = None,
    expected_duration_ms: Optional[int] = None,
) -> Mapping[str, Any]:
    """Validate and return a manifest without mutating it."""

    manifest = _mapping(value, "manifest")
    schema_version = _string(manifest, "schema_version", "schema_version")
    if schema_version != SCHEMA_VERSION:
        raise ContractValidationError(
            f"지원 버전은 {SCHEMA_VERSION}입니다", "schema_version"
        )

    revision = _integer(manifest, "revision", "revision", minimum=1)
    video = _mapping(manifest.get("video"), "video")
    provider = _string(video, "provider", "video.provider")
    video_id = _string(video, "video_id", "video.video_id")
    validate_video_key(provider, video_id)
    duration_ms = _integer(video, "duration_ms", "video.duration_ms", minimum=1)

    if expected_provider is not None and provider != expected_provider:
        raise ContractValidationError("요청 provider와 일치하지 않습니다", "video.provider")
    if expected_video_id is not None and video_id != expected_video_id:
        raise ContractValidationError("요청 video_id와 일치하지 않습니다", "video.video_id")
    if (
        expected_duration_ms is not None
        and abs(duration_ms - expected_duration_ms) > DURATION_TOLERANCE_MS
    ):
        raise ContractValidationError(
            f"카탈로그 길이와 {DURATION_TOLERANCE_MS}ms 넘게 차이 납니다",
            "video.duration_ms",
        )

    manifest_id = _string(manifest, "manifest_id", "manifest_id")
    expected_manifest_id = f"{provider}:{video_id}:r{revision}"
    if manifest_id != expected_manifest_id:
        raise ContractValidationError(
            f"{expected_manifest_id!r} 형식이어야 합니다", "manifest_id"
        )

    voice = _mapping(manifest.get("voice"), "voice")
    _string(voice, "voice_id", "voice.voice_id")
    audio_format = _string(voice, "format", "voice.format")
    if audio_format != "audio/wav":
        raise ContractValidationError("audio/wav만 지원합니다", "voice.format")
    _integer(voice, "sample_rate_hz", "voice.sample_rate_hz", minimum=1)

    playback = _mapping(manifest.get("playback"), "playback")
    _number(playback, "duck_factor", "playback.duck_factor", minimum=0, maximum=1)
    _integer(playback, "preload_count", "playback.preload_count", minimum=0)
    _integer(playback, "lookahead_ms", "playback.lookahead_ms", minimum=0)
    _integer(
        playback,
        "late_tolerance_ms",
        "playback.late_tolerance_ms",
        minimum=0,
    )
    auto_pause_default = playback.get("auto_pause_default")
    if not isinstance(auto_pause_default, bool):
        raise ContractValidationError("boolean이어야 합니다", "playback.auto_pause_default")
    max_extended_duration_ms = _integer(
        playback, "max_extended_duration_ms", "playback.max_extended_duration_ms", minimum=1
    )
    min_extended_interval_ms = _integer(
        playback, "min_extended_interval_ms", "playback.min_extended_interval_ms", minimum=0
    )

    segments = manifest.get("segments")
    if not isinstance(segments, list):
        raise ContractValidationError("배열이어야 합니다", "segments")

    previous_trigger_ms = -1
    previous_active_end_ms = -1
    previous_extended_trigger_ms: Optional[int] = None
    segment_ids: set[str] = set()
    for index, raw_segment in enumerate(segments):
        prefix = f"segments[{index}]"
        segment = _mapping(raw_segment, prefix)
        segment_id = _string(segment, "id", f"{prefix}.id")
        if segment_id in segment_ids:
            raise ContractValidationError("중복 ID입니다", f"{prefix}.id")
        segment_ids.add(segment_id)

        mode = _string(segment, "mode", f"{prefix}.mode")
        if mode not in {"overlay", "extended"}:
            raise ContractValidationError(
                "overlay 또는 extended여야 합니다", f"{prefix}.mode"
            )

        trigger_ms = _integer(segment, "trigger_ms", f"{prefix}.trigger_ms", minimum=0)
        if trigger_ms > duration_ms:
            raise ContractValidationError(
                "영상 길이를 넘을 수 없습니다", f"{prefix}.trigger_ms"
            )
        if trigger_ms < previous_trigger_ms:
            raise ContractValidationError(
                "trigger_ms 오름차순이어야 합니다", f"{prefix}.trigger_ms"
            )
        if previous_active_end_ms >= 0 and trigger_ms < previous_active_end_ms:
            raise ContractValidationError(
                "이전 세그먼트와 겹칩니다", f"{prefix}.trigger_ms"
            )

        _string(segment, "text", f"{prefix}.text")
        importance = _string(segment, "importance", f"{prefix}.importance")
        if importance not in {"normal", "high"}:
            raise ContractValidationError(
                "normal 또는 high여야 합니다", f"{prefix}.importance"
            )
        source = _string(segment, "source", f"{prefix}.source")
        if source not in {"ocr", "vlm"}:
            raise ContractValidationError("ocr 또는 vlm이어야 합니다", f"{prefix}.source")
        confidence = _string(segment, "confidence", f"{prefix}.confidence")
        if confidence != "high":
            raise ContractValidationError(
                "공개 playable 세그먼트는 high만 허용합니다",
                f"{prefix}.confidence",
            )

        audio = _mapping(segment.get("audio"), f"{prefix}.audio")
        clip_hash = validate_clip_hash(
            _string(audio, "sha256", f"{prefix}.audio.sha256"),
            f"{prefix}.audio.sha256",
        )
        audio_path = _string(audio, "path", f"{prefix}.audio.path")
        expected_path = f"/v1/audio/{clip_hash}.wav"
        if audio_path != expected_path:
            raise ContractValidationError(
                f"{expected_path!r}와 일치해야 합니다", f"{prefix}.audio.path"
            )
        clip_duration_ms = _integer(
            audio, "duration_ms", f"{prefix}.audio.duration_ms", minimum=1
        )

        if mode == "overlay":
            deadline_ms = segment.get("deadline_ms")
            if isinstance(deadline_ms, bool) or not isinstance(deadline_ms, int):
                raise ContractValidationError(
                    "overlay는 정수 deadline_ms가 필요합니다", f"{prefix}.deadline_ms"
                )
            if deadline_ms <= trigger_ms:
                raise ContractValidationError(
                    "trigger_ms보다 커야 합니다", f"{prefix}.deadline_ms"
                )
            if deadline_ms > duration_ms:
                raise ContractValidationError(
                    "영상 길이를 넘을 수 없습니다", f"{prefix}.deadline_ms"
                )
            if clip_duration_ms > deadline_ms - trigger_ms:
                raise ContractValidationError(
                    "deadline 안에 끝나야 합니다", f"{prefix}.audio.duration_ms"
                )
            active_end_ms = deadline_ms
        else:
            if "deadline_ms" in segment:
                raise ContractValidationError(
                    "extended는 deadline_ms를 포함하지 않습니다", f"{prefix}.deadline_ms"
                )
            if importance != "high":
                raise ContractValidationError(
                    "extended는 importance=high만 허용합니다", f"{prefix}.importance"
                )
            if clip_duration_ms > max_extended_duration_ms:
                raise ContractValidationError(
                    f"{max_extended_duration_ms}ms를 넘을 수 없습니다",
                    f"{prefix}.audio.duration_ms",
                )
            if (
                previous_extended_trigger_ms is not None
                and trigger_ms - previous_extended_trigger_ms < min_extended_interval_ms
            ):
                raise ContractValidationError(
                    f"extended 간격은 {min_extended_interval_ms}ms 이상이어야 합니다",
                    f"{prefix}.trigger_ms",
                )
            previous_extended_trigger_ms = trigger_ms
            active_end_ms = trigger_ms + clip_duration_ms

        previous_trigger_ms = trigger_ms
        previous_active_end_ms = active_end_ms

    return manifest
