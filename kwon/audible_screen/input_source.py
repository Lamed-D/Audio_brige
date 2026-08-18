from __future__ import annotations

import hashlib
import ipaddress
import os
import shutil
import time
from pathlib import Path
from typing import Callable
from urllib.parse import urlparse


LogFn = Callable[[str], None]


def validate_video_url(url: str) -> str:
    value = url.strip()
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("http:// 또는 https://로 시작하는 올바른 영상 URL을 입력하세요.")

    hostname = parsed.hostname.lower()
    if hostname == "localhost" or hostname.endswith(".local"):
        raise ValueError("로컬 네트워크 주소는 URL 입력으로 사용할 수 없습니다.")
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        address = None
    if address and (address.is_private or address.is_loopback or address.is_link_local):
        raise ValueError("사설 또는 로컬 IP 주소는 사용할 수 없습니다.")
    return value


def save_upload(file_bytes: bytes, filename: str, destination: Path) -> Path:
    suffix = Path(filename).suffix.lower() or ".mp4"
    target = destination / f"source{suffix}"
    target.write_bytes(file_bytes)
    return target


def download_video_url(
    url: str,
    destination: Path,
    log: LogFn,
    max_size_mb: int = 500,
    cache_dir: Path | None = None,
    cache_max_age_hours: int = 24 * 7,
) -> Path:
    safe_url = validate_video_url(url)
    destination.mkdir(parents=True, exist_ok=True)
    cache_entry: Path | None = None
    if cache_dir is not None:
        cache_key = hashlib.sha256(safe_url.encode("utf-8")).hexdigest()
        cache_entry = cache_dir / "downloads" / cache_key
        cached_files = [path for path in cache_entry.glob("source.*") if path.is_file()]
        if cached_files:
            newest = max(cached_files, key=lambda path: path.stat().st_mtime)
            age_hours = (time.time() - newest.stat().st_mtime) / 3600
            if age_hours <= cache_max_age_hours:
                target = destination / newest.name
                try:
                    os.link(newest, target)
                except OSError:
                    shutil.copy2(newest, target)
                log("같은 URL의 다운로드 캐시를 사용합니다.")
                return target

    try:
        import yt_dlp
    except ImportError as exc:
        raise RuntimeError("yt-dlp가 없습니다. pip install -r requirements.txt 를 실행하세요.") from exc

    def progress_hook(event: dict) -> None:
        if event.get("status") == "finished":
            log("URL 다운로드 완료, 영상/음성을 정리하는 중입니다.")

    base_options = {
        "outtmpl": str(destination / "source.%(ext)s"),
        "format": "bv*+ba/b",
        "merge_output_format": "mp4",
        "noplaylist": True,
        "max_filesize": max_size_mb * 1024 * 1024,
        "force_ipv4": True,
        "retries": 3,
        "fragment_retries": 3,
        "socket_timeout": 30,
        "quiet": True,
        "no_warnings": True,
        "progress_hooks": [progress_hook],
    }
    log("영상 URL을 내려받는 중입니다.")
    try:
        with yt_dlp.YoutubeDL(base_options) as downloader:
            downloader.download([safe_url])
    except yt_dlp.utils.DownloadError as exc:
        if "403" not in str(exc):
            raise

        log("YouTube가 기본 영상 스트림을 403으로 거부했습니다.")
        log("IPv4 기반 HLS 공개 스트림으로 한 번 더 시도합니다.")
        for path in destination.glob("source*"):
            if path.is_file():
                path.unlink(missing_ok=True)

        hls_options = {
            **base_options,
            "format": "best[protocol^=m3u8][height<=720]/best[protocol^=m3u8]/best",
            "extractor_args": {"youtube": {"player_client": ["web_safari"]}},
            "hls_prefer_native": True,
        }
        try:
            with yt_dlp.YoutubeDL(hls_options) as downloader:
                downloader.download([safe_url])
        except yt_dlp.utils.DownloadError as retry_exc:
            if "403" in str(retry_exc):
                raise RuntimeError(
                    "YouTube가 영상 다운로드를 403으로 차단했습니다. "
                    "이 영상은 현재 PO Token이 필요하거나 네트워크·지역·영상 정책상 "
                    "다운로드가 제한된 상태입니다. 권한이 있는 영상을 로컬 MP4로 "
                    "준비해 파일 업로드로 분석하세요."
                ) from retry_exc
            raise

    candidates = [
        path
        for path in destination.glob("source.*")
        if path.is_file() and path.suffix.lower() not in {".part", ".ytdl", ".json"}
    ]
    if not candidates:
        raise RuntimeError("URL에서 내려받은 영상 파일을 찾지 못했습니다.")
    result = max(candidates, key=lambda path: path.stat().st_size)
    if cache_entry is not None:
        cache_entry.mkdir(parents=True, exist_ok=True)
        cache_target = cache_entry / result.name
        cache_target.unlink(missing_ok=True)
        try:
            os.link(result, cache_target)
        except OSError:
            shutil.copy2(result, cache_target)
    return result
