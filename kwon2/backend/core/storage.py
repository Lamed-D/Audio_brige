"""SQLite-backed video/job/manifest metadata with file-backed WAV blobs."""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import threading
import uuid
import wave
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional

from core.contracts import (
    CATALOG_SCHEMA_VERSION,
    CLIP_HASH_RE,
    MANIFEST_SCHEMA_VERSION,
    ContractValidationError,
    validate_manifest,
    validate_video_key,
)


JOB_ID_RE = re.compile(r"^[0-9a-f]{32}$")
ACTIVE_JOB_STATUSES = {"queued", "processing"}
ALL_JOB_STATUSES = ACTIVE_JOB_STATUSES | {"ready", "failed"}


def _upgrade_legacy_manifest(raw: Any) -> Any:
    """서버 내부의 기존 1.0 결과를 공개 1.1 응답으로 안전하게 변환한다."""
    if not isinstance(raw, dict) or raw.get("schema_version") != "1.0":
        return raw
    upgraded = json.loads(json.dumps(raw))
    upgraded["schema_version"] = MANIFEST_SCHEMA_VERSION
    playback = upgraded.setdefault("playback", {})
    playback.setdefault("auto_pause_default", True)
    playback.setdefault("max_extended_duration_ms", 8_000)
    playback.setdefault("min_extended_interval_ms", 15_000)
    for segment in upgraded.get("segments", []):
        if not isinstance(segment, dict):
            continue
        segment["mode"] = "overlay"
        segment["trigger_ms"] = segment.pop("start_ms", 0)
        segment["deadline_ms"] = segment.pop("end_ms", segment["trigger_ms"] + 1)
        segment.setdefault("importance", "normal")
    return upgraded


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
    """SQLite is the source of truth; content-addressed WAV files remain on disk.

    ``catalog.json`` and older manifest/job JSON files are imported once for a
    non-destructive upgrade. A unique ``(provider, video_id)`` video row and
    idempotent active-job lookup prevent duplicate paid processing.
    """

    def __init__(self, data_dir: Path | str, database_path: Path | str | None = None):
        self.root = Path(data_dir).expanduser().resolve()
        self.catalog_path = self.root / "catalog.json"
        self.db_path = (
            Path(database_path).expanduser().resolve()
            if database_path is not None
            else self.root / "voice_bridge.sqlite3"
        )
        self.manifests_dir = self.root / "manifests"
        self.audio_dir = self.root / "audio"
        self.jobs_dir = self.root / "jobs"
        self._job_lock = threading.RLock()
        self._catalog_lock = threading.RLock()
        self.manifests_dir.mkdir(parents=True, exist_ok=True)
        self.audio_dir.mkdir(parents=True, exist_ok=True)
        self.jobs_dir.mkdir(parents=True, exist_ok=True)
        self._initialize_database()
        self._migrate_legacy_files()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 30000")
        return connection

    def _initialize_database(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS videos (
                    provider TEXT NOT NULL,
                    video_id TEXT NOT NULL,
                    duration_ms INTEGER NOT NULL CHECK(duration_ms > 0),
                    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (provider, video_id)
                );
                CREATE TABLE IF NOT EXISTS manifests (
                    provider TEXT NOT NULL,
                    video_id TEXT NOT NULL,
                    revision INTEGER NOT NULL CHECK(revision > 0),
                    manifest_id TEXT NOT NULL UNIQUE,
                    manifest_json TEXT NOT NULL,
                    etag TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY (provider, video_id, revision),
                    FOREIGN KEY (provider, video_id)
                        REFERENCES videos(provider, video_id)
                );
                CREATE INDEX IF NOT EXISTS manifests_latest_idx
                    ON manifests(provider, video_id, revision DESC);
                CREATE TABLE IF NOT EXISTS jobs (
                    job_id TEXT PRIMARY KEY,
                    provider TEXT NOT NULL,
                    video_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    FOREIGN KEY (provider, video_id)
                        REFERENCES videos(provider, video_id)
                );
                CREATE INDEX IF NOT EXISTS jobs_video_latest_idx
                    ON jobs(provider, video_id, created_at DESC);
                """
            )

    def _insert_video_row(
        self,
        connection: sqlite3.Connection,
        provider: str,
        video_id: str,
        duration_ms: int,
        *,
        enabled: bool = True,
        update_existing: bool = False,
    ) -> None:
        now = _now_iso()
        if update_existing:
            connection.execute(
                """
                INSERT INTO videos(provider, video_id, duration_ms, enabled, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(provider, video_id) DO UPDATE SET
                    duration_ms=excluded.duration_ms,
                    enabled=excluded.enabled,
                    updated_at=excluded.updated_at
                """,
                (provider, video_id, duration_ms, int(enabled), now, now),
            )
        else:
            connection.execute(
                """
                INSERT OR IGNORE INTO videos(
                    provider, video_id, duration_ms, enabled, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (provider, video_id, duration_ms, int(enabled), now, now),
            )

    def _migrate_legacy_files(self) -> None:
        """Import existing JSON artifacts without deleting or overwriting them."""
        with self._connect() as connection:
            if self.catalog_path.is_file():
                try:
                    raw_catalog = _read_json(self.catalog_path)
                except StorageError:
                    raw_catalog = None
                if isinstance(raw_catalog, Mapping):
                    for item in raw_catalog.get("videos", []):
                        if not isinstance(item, Mapping):
                            continue
                        try:
                            provider, video_id = validate_video_key(
                                item.get("provider"), item.get("video_id")
                            )
                        except ContractValidationError:
                            continue
                        duration_ms = item.get("duration_ms")
                        if isinstance(duration_ms, int) and not isinstance(duration_ms, bool) and duration_ms > 0:
                            self._insert_video_row(
                                connection,
                                provider,
                                video_id,
                                duration_ms,
                                enabled=item.get("enabled", True) is not False,
                            )

            for path in self.manifests_dir.glob("*/*.json"):
                try:
                    manifest = validate_manifest(_upgrade_legacy_manifest(_read_json(path)))
                except (StorageError, ContractValidationError):
                    continue
                provider = manifest["video"]["provider"]
                video_id = manifest["video"]["video_id"]
                self._insert_video_row(
                    connection,
                    provider,
                    video_id,
                    manifest["video"]["duration_ms"],
                )
                canonical = json.dumps(
                    manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")
                )
                etag = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
                connection.execute(
                    """
                    INSERT OR IGNORE INTO manifests(
                        provider, video_id, revision, manifest_id, manifest_json, etag, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        provider,
                        video_id,
                        manifest["revision"],
                        manifest["manifest_id"],
                        canonical,
                        etag,
                        _now_iso(),
                    ),
                )

            for path in self.jobs_dir.glob("*.json"):
                try:
                    raw_job = self._validate_job(_read_json(path), path)
                except (StorageError, JobInvalid):
                    continue
                self._insert_video_row(
                    connection,
                    raw_job["provider"],
                    raw_job["video_id"],
                    raw_job["duration_ms"],
                )
                connection.execute(
                    """
                    INSERT OR IGNORE INTO jobs(
                        job_id, provider, video_id, status, created_at, updated_at, payload_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        raw_job["job_id"],
                        raw_job["provider"],
                        raw_job["video_id"],
                        raw_job["status"],
                        raw_job["created_at"],
                        raw_job["updated_at"],
                        json.dumps(raw_job, ensure_ascii=False, separators=(",", ":")),
                    ),
                )

    def catalog(self) -> dict[str, CatalogVideo]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT provider, video_id, duration_ms FROM videos WHERE enabled=1"
            ).fetchall()
        return {
            f"{row['provider']}:{row['video_id']}": CatalogVideo(
                row["provider"], row["video_id"], row["duration_ms"]
            )
            for row in rows
        }

    def get_catalog_video(self, provider: str, video_id: str) -> Optional[CatalogVideo]:
        validate_video_key(provider, video_id)
        return self.catalog().get(f"{provider}:{video_id}")

    def upsert_catalog_video(self, provider: str, video_id: str, duration_ms: int) -> CatalogVideo:
        """영상 고유키를 SQLite에 등록하거나 실측 길이를 갱신한다."""
        validate_video_key(provider, video_id)
        if isinstance(duration_ms, bool) or not isinstance(duration_ms, int) or duration_ms <= 0:
            raise CatalogInvalid("duration_ms는 양의 정수여야 합니다")

        with self._catalog_lock:
            with self._connect() as connection:
                self._insert_video_row(
                    connection,
                    provider,
                    video_id,
                    duration_ms,
                    update_existing=True,
                )

        return CatalogVideo(provider, video_id, duration_ms)

    def health_summary(self) -> dict[str, Any]:
        with self._connect() as connection:
            video_count = connection.execute(
                "SELECT COUNT(*) FROM videos WHERE enabled=1"
            ).fetchone()[0]
            manifest_count = connection.execute(
                "SELECT COUNT(*) FROM manifests"
            ).fetchone()[0]
        return {
            "status": "ok",
            "schema_version": MANIFEST_SCHEMA_VERSION,
            "catalog_videos": video_count,
            "manifest_files": manifest_count,
            "storage": "sqlite",
        }

    def _manifest_path(self, provider: str, video_id: str) -> Path:
        validate_video_key(provider, video_id)
        return self.manifests_dir / provider / f"{video_id}.json"

    def find_manifest(
        self, provider: str, video_id: str, catalog_video: Optional[CatalogVideo] = None
    ) -> Optional[ManifestRecord]:
        validate_video_key(provider, video_id)
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT manifest_json, etag FROM manifests
                WHERE provider=? AND video_id=?
                ORDER BY revision DESC LIMIT 1
                """,
                (provider, video_id),
            ).fetchone()
        if row is None:
            return None
        try:
            raw = json.loads(row["manifest_json"])
            manifest = validate_manifest(
                raw,
                expected_provider=provider,
                expected_video_id=video_id,
                expected_duration_ms=(catalog_video.duration_ms if catalog_video else None),
            )
            self._validate_manifest_audio(manifest)
        except (StorageError, ContractValidationError) as exc:
            raise ManifestInvalid(f"DB manifest: {exc}") from exc
        return ManifestRecord(data=manifest, etag=row["etag"])

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
            allowed_duration_ms = (
                segment["deadline_ms"] - segment["trigger_ms"]
                if segment["mode"] == "overlay"
                else manifest["playback"]["max_extended_duration_ms"]
            )
            if actual_duration_ms > allowed_duration_ms:
                raise ManifestInvalid(
                    f"{path.name} 실측 길이가 {segment['mode']} 허용 구간을 넘습니다"
                )

    def next_revision(self, provider: str, video_id: str) -> int:
        validate_video_key(provider, video_id)
        with self._connect() as connection:
            revision = connection.execute(
                "SELECT COALESCE(MAX(revision), 0) FROM manifests WHERE provider=? AND video_id=?",
                (provider, video_id),
            ).fetchone()[0]
        return int(revision) + 1

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
        """검증된 revision을 DB에 게시하고 JSON 호환 사본도 원자적으로 쓴다."""
        try:
            validated = validate_manifest(manifest)
        except ContractValidationError as exc:
            raise ManifestInvalid(f"게시하려는 manifest가 스키마를 위반합니다: {exc}") from exc
        self._validate_manifest_audio(validated)

        provider = validated["video"]["provider"]
        video_id = validated["video"]["video_id"]
        canonical = json.dumps(
            validated, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )
        etag = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        with self._connect() as connection:
            self._insert_video_row(
                connection,
                provider,
                video_id,
                validated["video"]["duration_ms"],
            )
            connection.execute(
                """
                INSERT INTO manifests(
                    provider, video_id, revision, manifest_id, manifest_json, etag, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(provider, video_id, revision) DO UPDATE SET
                    manifest_id=excluded.manifest_id,
                    manifest_json=excluded.manifest_json,
                    etag=excluded.etag,
                    created_at=excluded.created_at
                """,
                (
                    provider,
                    video_id,
                    validated["revision"],
                    validated["manifest_id"],
                    canonical,
                    etag,
                    _now_iso(),
                ),
            )
        path = self._manifest_path(provider, video_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        payload = json.dumps(validated, ensure_ascii=False, indent=2) + "\n"
        try:
            temp_path.write_text(payload, encoding="utf-8")
            os.replace(temp_path, path)
        finally:
            temp_path.unlink(missing_ok=True)

        return ManifestRecord(data=validated, etag=etag)

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
        # v1.1 이전에 저장된 로컬 job도 새 공개 JobStatus로 읽을 수 있게 보완한다.
        raw.setdefault("stage", "queued" if raw["status"] == "queued" else "validation")
        raw.setdefault("progress_percent", 100 if raw["status"] == "ready" else 0)
        raw.setdefault("eta_seconds", None)
        raw.setdefault("eta_confidence", None)
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
        payload = json.dumps(job, ensure_ascii=False, separators=(",", ":"))
        try:
            with self._connect() as connection:
                connection.execute(
                    """
                    INSERT INTO jobs(
                        job_id, provider, video_id, status, created_at, updated_at, payload_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(job_id) DO UPDATE SET
                        status=excluded.status,
                        updated_at=excluded.updated_at,
                        payload_json=excluded.payload_json
                    """,
                    (
                        job["job_id"],
                        job["provider"],
                        job["video_id"],
                        job["status"],
                        job["created_at"],
                        job["updated_at"],
                        payload,
                    ),
                )
            # 사람이 열어볼 수 있는 호환 사본이며 DB가 실제 기준이다.
            temp_path = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
            temp_path.write_text(
                json.dumps(job, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )
            os.replace(temp_path, path)
        except (OSError, sqlite3.Error) as exc:
            raise JobInvalid(f"job 저장 실패: {path.name}: {exc}") from exc
        finally:
            try:
                if "temp_path" in locals():
                    temp_path.unlink(missing_ok=True)
            except OSError:
                pass

    def _jobs(self) -> Iterable[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT job_id, payload_json FROM jobs ORDER BY created_at"
            ).fetchall()
        for row in rows:
            path = self._job_path(row["job_id"])
            try:
                yield self._validate_job(json.loads(row["payload_json"]), path)
            except json.JSONDecodeError as exc:
                raise JobInvalid(f"DB job JSON 손상: {row['job_id']}") from exc

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

    def create_or_get_job(
        self, video: CatalogVideo, *, force: bool = False
    ) -> dict[str, Any]:
        with self._job_lock:
            existing = self.latest_job_for_video(video.provider, video.video_id)
            if existing and existing["status"] in ACTIVE_JOB_STATUSES:
                return self.refresh_job(existing["job_id"]) or existing
            if not force and existing and existing["status"] == "ready":
                manifest = self.find_manifest(video.provider, video.video_id, video)
                if manifest is not None:
                    return existing

            manifest = self.find_manifest(video.provider, video.video_id, video)
            target_revision = self.next_revision(video.provider, video.video_id)
            ready = manifest is not None and not force
            now = _now_iso()
            job = {
                "job_id": uuid.uuid4().hex,
                "provider": video.provider,
                "video_id": video.video_id,
                "duration_ms": video.duration_ms,
                "status": "ready" if ready else "queued",
                "stage": "validation" if ready else "queued",
                "progress_percent": 100 if ready else 0,
                "eta_seconds": 0 if ready else None,
                "eta_confidence": "high" if ready else None,
                "created_at": now,
                "updated_at": now,
            }
            if force:
                # 기존 rN은 재생 가능한 상태로 유지하고, rN+1이 게시될 때까지 이
                # 작업을 ready로 바꾸지 않는다.
                job["target_revision"] = target_revision
            self._write_job(job)
            return job

    def get_job(self, job_id: str) -> Optional[dict[str, Any]]:
        path = self._job_path(job_id)
        with self._connect() as connection:
            row = connection.execute(
                "SELECT payload_json FROM jobs WHERE job_id=?", (job_id,)
            ).fetchone()
        if row is None:
            return None
        try:
            raw = json.loads(row["payload_json"])
        except json.JSONDecodeError as exc:
            raise JobInvalid(f"DB job JSON 손상: {job_id}") from exc
        return self._validate_job(raw, path)

    def update_job(self, job_id: str, **changes: Any) -> dict[str, Any]:
        """백그라운드 워커가 단조 증가 진행률과 상태를 원자적으로 기록한다."""
        with self._job_lock:
            job = self.get_job(job_id)
            if job is None:
                raise JobInvalid("업데이트할 job을 찾을 수 없습니다")
            progress = changes.get("progress_percent")
            if progress is not None:
                if isinstance(progress, bool) or not isinstance(progress, int) or not 0 <= progress <= 100:
                    raise JobInvalid("progress_percent는 0~100 정수여야 합니다")
                changes["progress_percent"] = max(job.get("progress_percent", 0), progress)
            job.update(changes)
            job["updated_at"] = _now_iso()
            self._write_job(job)
            return job

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
            target_revision = job.get("target_revision")
            target_ready = (
                manifest is not None
                and (
                    not isinstance(target_revision, int)
                    or manifest.data["revision"] >= target_revision
                )
            )
            if target_ready:
                if job["status"] != "ready" or "error" in job:
                    job["status"] = "ready"
                    job["stage"] = "validation"
                    job["progress_percent"] = 100
                    job["eta_seconds"] = 0
                    job["eta_confidence"] = "high"
                    job.pop("error", None)
                    job["updated_at"] = _now_iso()
                    self._write_job(job)
            elif manifest is None and job["status"] == "ready":
                job["status"] = "failed"
                job["error"] = {
                    "code": "MANIFEST_NOT_FOUND",
                    "message": "ready 작업의 매니페스트가 더 이상 존재하지 않습니다",
                }
                job["updated_at"] = _now_iso()
                self._write_job(job)
            return job
