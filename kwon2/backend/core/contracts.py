"""VOICE BRIDGE public manifest v1.1 contract validation."""

from __future__ import annotations

import math
import re
from typing import Any, Mapping, Optional

MANIFEST_SCHEMA_VERSION = "1.1"
CATALOG_SCHEMA_VERSION = "1.0"
SCHEMA_VERSION = MANIFEST_SCHEMA_VERSION  # 기존 import 호환
DURATION_TOLERANCE_MS = 1_000
PROVIDER_RE = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
CLIP_HASH_RE = re.compile(r"^[0-9a-f]{64}$")


class ContractValidationError(ValueError):
    def __init__(self, message: str, field: Optional[str] = None):
        self.field = field
        super().__init__((f"{field}: " if field else "") + message)


def validate_video_key(provider: Any, video_id: Any) -> tuple[str, str]:
    if not isinstance(provider, str) or not PROVIDER_RE.fullmatch(provider):
        raise ContractValidationError("소문자 영문으로 시작하고 영문·숫자·_·-만 사용할 수 있습니다", "provider")
    if not isinstance(video_id, str) or not VIDEO_ID_RE.fullmatch(video_id):
        raise ContractValidationError("영문·숫자·_·-로 된 1~128자 값이어야 합니다", "video_id")
    return provider, video_id


def validate_clip_hash(value: Any, field: str = "clip_hash") -> str:
    if not isinstance(value, str) or not CLIP_HASH_RE.fullmatch(value):
        raise ContractValidationError("64자리 소문자 SHA-256이어야 합니다", field)
    return value


def _mapping(value: Any, field: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ContractValidationError("객체여야 합니다", field)
    return value


def _string(obj: Mapping[str, Any], key: str, field: str) -> str:
    value = obj.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ContractValidationError("비어 있지 않은 문자열이어야 합니다", field)
    return value


def _integer(obj: Mapping[str, Any], key: str, field: str, *, minimum: int = 0) -> int:
    value = obj.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ContractValidationError("정수 밀리초 값이어야 합니다", field)
    if value < minimum:
        raise ContractValidationError(f"{minimum} 이상이어야 합니다", field)
    return value


def _number(obj: Mapping[str, Any], key: str, field: str, *, minimum: float, maximum: float) -> float:
    value = obj.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ContractValidationError("숫자여야 합니다", field)
    number = float(value)
    if not math.isfinite(number) or not minimum <= number <= maximum:
        raise ContractValidationError(f"{minimum}~{maximum} 범위여야 합니다", field)
    return number


def validate_manifest(
    value: Any,
    *,
    expected_provider: Optional[str] = None,
    expected_video_id: Optional[str] = None,
    expected_duration_ms: Optional[int] = None,
) -> Mapping[str, Any]:
    manifest = _mapping(value, "manifest")
    if _string(manifest, "schema_version", "schema_version") != MANIFEST_SCHEMA_VERSION:
        raise ContractValidationError(f"지원 버전은 {MANIFEST_SCHEMA_VERSION}입니다", "schema_version")

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
    if expected_duration_ms is not None and abs(duration_ms - expected_duration_ms) > DURATION_TOLERANCE_MS:
        raise ContractValidationError("카탈로그 길이와 1000ms 넘게 차이 납니다", "video.duration_ms")

    expected_manifest_id = f"{provider}:{video_id}:r{revision}"
    if _string(manifest, "manifest_id", "manifest_id") != expected_manifest_id:
        raise ContractValidationError(f"{expected_manifest_id!r} 형식이어야 합니다", "manifest_id")

    voice = _mapping(manifest.get("voice"), "voice")
    _string(voice, "voice_id", "voice.voice_id")
    if _string(voice, "format", "voice.format") != "audio/wav":
        raise ContractValidationError("audio/wav만 지원합니다", "voice.format")
    _integer(voice, "sample_rate_hz", "voice.sample_rate_hz", minimum=1)

    playback = _mapping(manifest.get("playback"), "playback")
    _number(playback, "duck_factor", "playback.duck_factor", minimum=0, maximum=1)
    for key in ("preload_count", "lookahead_ms", "late_tolerance_ms"):
        _integer(playback, key, f"playback.{key}")
    if not isinstance(playback.get("auto_pause_default"), bool):
        raise ContractValidationError("boolean이어야 합니다", "playback.auto_pause_default")
    max_extended_ms = _integer(playback, "max_extended_duration_ms", "playback.max_extended_duration_ms", minimum=1)
    min_extended_interval_ms = _integer(playback, "min_extended_interval_ms", "playback.min_extended_interval_ms")

    segments = manifest.get("segments")
    if not isinstance(segments, list):
        raise ContractValidationError("배열이어야 합니다", "segments")
    ids: set[str] = set()
    previous_trigger = -1
    previous_extended = -min_extended_interval_ms
    for index, raw in enumerate(segments):
        prefix = f"segments[{index}]"
        segment = _mapping(raw, prefix)
        segment_id = _string(segment, "id", f"{prefix}.id")
        if segment_id in ids:
            raise ContractValidationError("중복 ID입니다", f"{prefix}.id")
        ids.add(segment_id)
        mode = _string(segment, "mode", f"{prefix}.mode")
        if mode not in {"overlay", "extended"}:
            raise ContractValidationError("overlay 또는 extended여야 합니다", f"{prefix}.mode")
        trigger_ms = _integer(segment, "trigger_ms", f"{prefix}.trigger_ms")
        if trigger_ms > duration_ms:
            raise ContractValidationError("영상 길이를 넘을 수 없습니다", f"{prefix}.trigger_ms")
        if trigger_ms < previous_trigger:
            raise ContractValidationError("trigger_ms 오름차순이어야 합니다", f"{prefix}.trigger_ms")
        previous_trigger = trigger_ms

        importance = _string(segment, "importance", f"{prefix}.importance")
        if importance not in {"normal", "high"}:
            raise ContractValidationError("normal 또는 high여야 합니다", f"{prefix}.importance")
        if mode == "extended":
            if importance != "high":
                raise ContractValidationError("extended는 high 중요도만 허용합니다", f"{prefix}.importance")
            if trigger_ms - previous_extended < min_extended_interval_ms:
                raise ContractValidationError("extended 최소 간격보다 짧습니다", f"{prefix}.trigger_ms")
            previous_extended = trigger_ms

        _string(segment, "text", f"{prefix}.text")
        if _string(segment, "source", f"{prefix}.source") not in {"ocr", "vlm"}:
            raise ContractValidationError("ocr 또는 vlm이어야 합니다", f"{prefix}.source")
        if _string(segment, "confidence", f"{prefix}.confidence") != "high":
            raise ContractValidationError("공개 세그먼트는 high만 허용합니다", f"{prefix}.confidence")

        audio = _mapping(segment.get("audio"), f"{prefix}.audio")
        clip_hash = validate_clip_hash(_string(audio, "sha256", f"{prefix}.audio.sha256"), f"{prefix}.audio.sha256")
        if _string(audio, "path", f"{prefix}.audio.path") != f"/v1/audio/{clip_hash}.wav":
            raise ContractValidationError("sha256 기반 오디오 경로와 일치해야 합니다", f"{prefix}.audio.path")
        clip_duration_ms = _integer(audio, "duration_ms", f"{prefix}.audio.duration_ms", minimum=1)
        if mode == "overlay":
            deadline_ms = _integer(segment, "deadline_ms", f"{prefix}.deadline_ms", minimum=1)
            if deadline_ms <= trigger_ms or deadline_ms > duration_ms:
                raise ContractValidationError("trigger 뒤이며 영상 길이 이하여야 합니다", f"{prefix}.deadline_ms")
            if clip_duration_ms > deadline_ms - trigger_ms:
                raise ContractValidationError("자연 무음 구간 길이를 넘습니다", f"{prefix}.audio.duration_ms")
        elif clip_duration_ms > max_extended_ms:
            raise ContractValidationError("extended 최대 길이를 넘습니다", f"{prefix}.audio.duration_ms")

    return manifest
