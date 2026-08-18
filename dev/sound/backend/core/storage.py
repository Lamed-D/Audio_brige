"""File-backed catalog, manifest, audio, and POC job storage."""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import uuid
import wave
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional

from core.contracts import (
    CLIP_HASH_RE,
    SCHEMA_VERSION,
    ContractValidationError,
    validate_manifest,
    validate_video_key,
)


JOB_ID_RE = re.compile(r"^[0-9a-f]{32}$")
ACTIVE_JOB_STATUSES = {"queued", "processing"}
ALL_JOB_STATUSES = ACTIVE_JOB_STATUSES | {"ready", "failed"}


class StorageError(RuntimeError):
    """Base class for storage/configuration failures."""


class CatalogInvalid(StorageError):
    pass


class ManifestInvalid(StorageError):
    pass


class AudioInvalid(StorageError):
    pass


class JobInvalid(StorageError):
    pass


@dataclass(frozen=True)
class CatalogVideo:
    provider: str
    video_id: str
    duration_ms: int

    @property
    def key(self) -> str:
        return f"{self.provider}:{self.video_id}"


@dataclass(frozen=True)
class ManifestRecord:
    data: Mapping[str, Any]
    etag: str


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise StorageError(f"JSON 파일을 읽을 수 없습니다: {path.name}: {exc}") from exc


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as exc:
        raise AudioInvalid(f"오디오 파일을 읽을 수 없습니다: {path.name}: {exc}") from exc
    return digest.hexdigest()


class FileRepository:
    """A small, deterministic repository suited to a preprocessed POC.

    Pipeline workers publish an audio file first and then atomically place a
    validated manifest under ``manifests/<provider>/<video_id>.json``.  Job
    state changes to ``ready`` the next time either the job or manifest API is
    queried.
    """

    def __init__(self, data_dir: Path | str):
        self.root = Path(data_dir).expanduser().resolve()
        self.catalog_path = self.root / "catalog.json"
        self.manifests_dir = self.root / "manifests"
        self.audio_dir = self.root / "audio"
        self.jobs_dir = self.root / "jobs"
        self._job_lock = threading.RLock()
        self._catalog_lock = threading.RLock()
        self.manifests_dir.mkdir(parents=True, exist_ok=True)
        self.audio_dir.mkdir(parents=True, exist_ok=True)
        self.jobs_dir.mkdir(parents=True, exist_ok=True)

    def catalog(self) -> dict[str, CatalogVideo]:
        try:
            raw = _read_json(self.catalog_path)
        except FileNotFoundError as exc:
            raise CatalogInvalid(f"catalog.json이 없습니다: {self.catalog_path}") from exc
        except StorageError as exc:
            raise CatalogInvalid(str(exc)) from exc

        if not isinstance(raw, Mapping):
            raise CatalogInvalid("catalog.json 최상위 값은 객체여야 합니다")
        if raw.get("schema_version") != SCHEMA_VERSION:
            raise CatalogInvalid(f"catalog schema_version은 {SCHEMA_VERSION}이어야 합니다")
        videos = raw.get("videos")
        if not isinstance(videos, list):
            raise CatalogInvalid("catalog.videos는 배열이어야 합니다")

        result: dict[str, CatalogVideo] = {}
        for index, item in enumerate(videos):
            if not isinstance(item, Mapping):
                raise CatalogInvalid(f"catalog.videos[{index}]는 객체여야 합니다")
            enabled = item.get("enabled", True)
            if not isinstance(enabled, bool):
                raise CatalogInvalid(f"catalog.videos[{index}].enabled는 boolean이어야 합니다")
            if not enabled:
                continue
            try:
                provider, video_id = validate_video_key(
                    item.get("provider"), item.get("video_id")
                )
            except ContractValidationError as exc:
                raise CatalogInvalid(f"catalog.videos[{index}]: {exc}") from exc
            duration_ms = item.get("duration_ms")
            if (
                isinstance(duration_ms, bool)
                or not isinstance(duration_ms, int)
                or duration_ms <= 0
            ):
                raise CatalogInvalid(
                    f"catalog.videos[{index}].duration_ms는 양의 정수여야 합니다"
                )
            video = CatalogVideo(provider, video_id, duration_ms)
            if video.key in result:
                raise CatalogInvalid(f"중복 영상 키입니다: {video.key}")
            result[video.key] = video
        return result

    def get_catalog_video(self, provider: str, video_id: str) -> Optional[CatalogVideo]:
        validate_video_key(provider, video_id)
        return self.catalog().get(f"{provider}:{video_id}")

    def upsert_catalog_video(self, provider: str, video_id: str, duration_ms: int) -> CatalogVideo:
        """catalog.json 에 항목을 추가하거나 duration_ms 를 갱신한다.

        dev 전용 등록 흐름(api/dev.py)에서만 쓴다 — 공개 /v1 API 는 카탈로그를
        쓰지 않고 읽기만 한다. 등록 시점에 항상 이 저장소를 통해서만 검증된
        형식으로 쓰기 때문에 catalog.json 이 손상될 일이 없다.
        """
        validate_video_key(provider, video_id)
        if isinstance(duration_ms, bool) or not isinstance(duration_ms, int) or duration_ms <= 0:
            raise CatalogInvalid("duration_ms는 양의 정수여야 합니다")

        with self._catalog_lock:
            try:
                raw = _read_json(self.catalog_path)
            except FileNotFoundError:
                raw = {"schema_version": SCHEMA_VERSION, "videos": []}
            except StorageError as exc:
                raise CatalogInvalid(str(exc)) from exc

            if not isinstance(raw, dict) or not isinstance(raw.get("videos"), list):
                raise CatalogInvalid("catalog.json 형식이 올바르지 않아 자동으로 고칠 수 없습니다")
            raw["schema_version"] = SCHEMA_VERSION

            videos = raw["videos"]
            updated = False
            for entry in videos:
                if (
                    isinstance(entry, dict)
                    and entry.get("provider") == provider
                    and entry.get("video_id") == video_id
                ):
                    entry["duration_ms"] = duration_ms
                    entry["enabled"] = True
                    updated = True
                    break
            if not updated:
                videos.append(
                    {"provider": provider, "video_id": video_id, "duration_ms": duration_ms, "enabled": True}
                )

            temp_path = self.catalog_path.with_name(f".{self.catalog_path.name}.{uuid.uuid4().hex}.tmp")
            try:
                temp_path.write_text(
                    json.dumps(raw, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
                )
                os.replace(temp_path, self.catalog_path)
            finally:
                temp_path.unlink(missing_ok=True)

        return CatalogVideo(provider, video_id, duration_ms)

    def health_summary(self) -> dict[str, Any]:
        catalog = self.catalog()
        manifest_files = sum(1 for _ in self.manifests_dir.glob("*/*.json"))
        return {
            "status": "ok",
            "schema_version": SCHEMA_VERSION,
            "catalog_videos": len(catalog),
            "manifest_files": manifest_files,
        }

    def _manifest_path(self, provider: str, video_id: str) -> Path:
        validate_video_key(provider, video_id)
        return self.manifests_dir / provider / f"{video_id}.json"

    def find_manifest(
        self, provider: str, video_id: str, catalog_video: Optional[CatalogVideo] = None
    ) -> Optional[ManifestRecord]:
        path = self._manifest_path(provider, video_id)
        if not path.is_file():
            return None
        try:
            raw = _read_json(path)
            manifest = validate_manifest(
                raw,
                expected_provider=provider,
                expected_video_id=video_id,
                expected_duration_ms=(catalog_video.duration_ms if catalog_video else None),
            )
            self._validate_manifest_audio(manifest)
        except (StorageError, ContractValidationError) as exc:
            raise ManifestInvalid(f"{path.name}: {exc}") from exc

        canonical = json.dumps(
            manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
        return ManifestRecord(data=manifest, etag=hashlib.sha256(canonical).hexdigest())

    def _validate_manifest_audio(self, manifest: Mapping[str, Any]) -> None:
        sample_rate = int(manifest["voice"]["sample_rate_hz"])
        for segment in manifest["segments"]:
            audio = segment["audio"]
            clip_hash = audio["sha256"]
            path = self.audio_dir / f"{clip_hash}.wav"
            if not path.is_file():
                raise ManifestInvalid(f"오디오 파일이 없습니다: {path.name}")
            actual_hash = _sha256_file(path)
            if actual_hash != clip_hash:
                raise ManifestInvalid(
                    f"오디오 SHA-256 불일치: {path.name} ({actual_hash})"
                )

            try:
                with wave.open(str(path), "rb") as wav:
                    channels = wav.getnchannels()
                    sample_width = wav.getsampwidth()
                    frame_rate = wav.getframerate()
                    frames = wav.getnframes()
            except (OSError, EOFError, wave.Error) as exc:
                raise ManifestInvalid(f"유효한 PCM WAV가 아닙니다: {path.name}: {exc}") from exc
            if channels != 1 or sample_width != 2 or frame_rate != sample_rate:
                raise ManifestInvalid(
                    f"{path.name}은 PCM 16-bit mono {sample_rate}Hz여야 합니다"
                )
            actual_duration_ms = round(frames * 1000 / frame_rate)
            declared_duration_ms = audio["duration_ms"]
            if abs(actual_duration_ms - declared_duration_ms) > 50:
                raise ManifestInvalid(
                    f"{path.name} 실측 길이 {actual_duration_ms}ms와 manifest 길이 "
                    f"{declared_duration_ms}ms가 일치하지 않습니다"
                )
            gap_duration_ms = segment["end_ms"] - segment["start_ms"]
            if actual_duration_ms > gap_duration_ms:
                raise ManifestInvalid(
                    f"{path.name} 실측 길이가 세그먼트 구간을 넘습니다"
                )

    def next_revision(self, provider: str, video_id: str) -> int:
        """다음에 게시할 manifest의 revision 번호. 기존 manifest가 깨져 있어도
        재생성을 막지 않도록 손상된 파일은 조용히 무시하고 1부터 시작한다."""
        path = self._manifest_path(provider, video_id)
        if not path.is_file():
            return 1
        try:
            raw = _read_json(path)
        except StorageError:
            return 1
        revision = raw.get("revision") if isinstance(raw, Mapping) else None
        if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
            return 1
        return revision + 1

    def publish_audio(self, wav_bytes: bytes) -> str:
        """WAV 바이트를 SHA-256 파일명으로 audio/ 아래 저장한다 (이미 있으면 재사용)."""
        clip_hash = hashlib.sha256(wav_bytes).hexdigest()
        path = self.audio_dir / f"{clip_hash}.wav"
        if not path.is_file():
            temp_path = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
            try:
                temp_path.write_bytes(wav_bytes)
                os.replace(temp_path, path)
            finally:
                temp_path.unlink(missing_ok=True)
        return clip_hash

    def publish_manifest(self, manifest: Mapping[str, Any]) -> ManifestRecord:
        """검증을 통과한 manifest만 원자적으로 게시한다 (불완전한 manifest는 절대 노출하지 않음)."""
        try:
            validated = validate_manifest(manifest)
        except ContractValidationError as exc:
            raise ManifestInvalid(f"게시하려는 manifest가 스키마를 위반합니다: {exc}") from exc
        self._validate_manifest_audio(validated)

        provider = validated["video"]["provider"]
        video_id = validated["video"]["video_id"]
        path = self._manifest_path(provider, video_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        payload = json.dumps(validated, ensure_ascii=False, indent=2) + "\n"
        try:
            temp_path.write_text(payload, encoding="utf-8")
            os.replace(temp_path, path)
        finally:
            temp_path.unlink(missing_ok=True)

        record = self.find_manifest(provider, video_id)
        assert record is not None  # 방금 검증하고 쓴 파일이므로 항상 읽혀야 한다
        return record

    def get_audio_path(self, clip_hash: str) -> Optional[Path]:
        if not CLIP_HASH_RE.fullmatch(clip_hash):
            raise ContractValidationError("64자리 소문자 SHA-256이어야 합니다", "clip_hash")
        path = self.audio_dir / f"{clip_hash}.wav"
        if not path.is_file():
            return None
        actual_hash = _sha256_file(path)
        if actual_hash != clip_hash:
            raise AudioInvalid(f"오디오 SHA-256 불일치: {path.name}")
        return path

    def _job_path(self, job_id: str) -> Path:
        if not JOB_ID_RE.fullmatch(job_id):
            raise ContractValidationError("32자리 소문자 hex여야 합니다", "job_id")
        return self.jobs_dir / f"{job_id}.json"

    def _validate_job(self, raw: Any, path: Path) -> dict[str, Any]:
        if not isinstance(raw, dict):
            raise JobInvalid(f"{path.name}: job은 객체여야 합니다")
        required_strings = (
            "job_id",
            "provider",
            "video_id",
            "status",
            "created_at",
            "updated_at",
        )
        if any(not isinstance(raw.get(field), str) for field in required_strings):
            raise JobInvalid(f"{path.name}: 필수 문자열 필드가 없습니다")
        if not JOB_ID_RE.fullmatch(raw["job_id"]) or raw["job_id"] != path.stem:
            raise JobInvalid(f"{path.name}: job_id가 파일명과 일치하지 않습니다")
        try:
            validate_video_key(raw["provider"], raw["video_id"])
        except ContractValidationError as exc:
            raise JobInvalid(f"{path.name}: {exc}") from exc
        if raw["status"] not in ALL_JOB_STATUSES:
            raise JobInvalid(f"{path.name}: 알 수 없는 status입니다")
        duration_ms = raw.get("duration_ms")
        if isinstance(duration_ms, bool) or not isinstance(duration_ms, int) or duration_ms <= 0:
            raise JobInvalid(f"{path.name}: duration_ms는 양의 정수여야 합니다")
        return raw

    def _read_job(self, path: Path) -> dict[str, Any]:
        try:
            raw = _read_json(path)
        except FileNotFoundError:
            raise
        except StorageError as exc:
            raise JobInvalid(str(exc)) from exc
        return self._validate_job(raw, path)

    def _write_job(self, job: Mapping[str, Any]) -> None:
        path = self._job_path(str(job["job_id"]))
        temp_path = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        try:
            temp_path.write_text(
                json.dumps(job, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )
            os.replace(temp_path, path)
        except OSError as exc:
            raise JobInvalid(f"job 저장 실패: {path.name}: {exc}") from exc
        finally:
            try:
                temp_path.unlink(missing_ok=True)
            except OSError:
                pass

    def _jobs(self) -> Iterable[dict[str, Any]]:
        for path in self.jobs_dir.glob("*.json"):
            yield self._read_job(path)

    def latest_job_for_video(
        self,
        provider: str,
        video_id: str,
        *,
        statuses: Optional[set[str]] = None,
    ) -> Optional[dict[str, Any]]:
        matches = [
            job
            for job in self._jobs()
            if job["provider"] == provider
            and job["video_id"] == video_id
            and (statuses is None or job["status"] in statuses)
        ]
        return max(matches, key=lambda job: job["created_at"], default=None)

    def create_or_get_job(self, video: CatalogVideo) -> dict[str, Any]:
        with self._job_lock:
            existing = self.latest_job_for_video(video.provider, video.video_id)
            if existing and existing["status"] in ACTIVE_JOB_STATUSES:
                return self.refresh_job(existing["job_id"]) or existing
            if existing and existing["status"] == "ready":
                manifest = self.find_manifest(video.provider, video.video_id, video)
                if manifest is not None:
                    return existing

            manifest = self.find_manifest(video.provider, video.video_id, video)
            now = _now_iso()
            job = {
                "job_id": uuid.uuid4().hex,
                "provider": video.provider,
                "video_id": video.video_id,
                "duration_ms": video.duration_ms,
                "status": "ready" if manifest else "queued",
                "created_at": now,
                "updated_at": now,
            }
            self._write_job(job)
            return job

    def get_job(self, job_id: str) -> Optional[dict[str, Any]]:
        path = self._job_path(job_id)
        if not path.is_file():
            return None
        return self._read_job(path)

    def refresh_job(self, job_id: str) -> Optional[dict[str, Any]]:
        with self._job_lock:
            job = self.get_job(job_id)
            if job is None or job["status"] not in ACTIVE_JOB_STATUSES | {"ready"}:
                return job
            video = self.get_catalog_video(job["provider"], job["video_id"])
            if video is None:
                job["status"] = "failed"
                job["error"] = {
                    "code": "VIDEO_NOT_REGISTERED",
                    "message": "카탈로그에서 영상이 제거되었습니다",
                    "retryable": False,
                }
                job["updated_at"] = _now_iso()
                self._write_job(job)
                return job
            try:
                manifest = self.find_manifest(job["provider"], job["video_id"], video)
            except ManifestInvalid as exc:
                job["status"] = "failed"
                job["error"] = {
                    "code": "MANIFEST_INVALID",
                    "message": str(exc),
                    "retryable": False,
                }
                job["updated_at"] = _now_iso()
                self._write_job(job)
                return job
            if manifest is not None:
                if job["status"] != "ready" or "error" in job:
                    job["status"] = "ready"
                    job.pop("error", None)
                    job["updated_at"] = _now_iso()
                    self._write_job(job)
            elif job["status"] == "ready":
                job["status"] = "failed"
                job["error"] = {
                    "code": "MANIFEST_NOT_FOUND",
                    "message": "ready 작업의 매니페스트가 더 이상 존재하지 않습니다",
                }
                job["updated_at"] = _now_iso()
                self._write_job(job)
            return job
