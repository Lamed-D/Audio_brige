"""유튜브는 스트리밍이라 파일이 아니다 — 파이프라인이 다룰 수 있는 로컬 mp4로
먼저 받아 둔다.

이 모듈은 오퍼레이터가 수동으로 실행하는 사전 처리 단계에서만 쓴다. 브라우저나
/v1 API 는 이 코드를 절대 호출하지 않는다 — 임의 URL을 서버가 대신 수집하지
않는다는 원칙(연동규격 1.3, 8.1)은 "요청 시점의 실시간 수집"에 대한 것이고,
권리를 확인한 영상을 운영자가 직접 사전 처리하는 이 단계와는 다른 문제다.
이 도구를 실행하는 사람이 해당 영상을 처리할 권리가 있는지 스스로 확인해야
한다.
"""

from __future__ import annotations

from pathlib import Path

import imageio_ffmpeg
import yt_dlp


def download_youtube(video_id: str, output_path: str) -> str:
    if not video_id or "/" in video_id or "\\" in video_id:
        raise ValueError(f"video_id 형식이 올바르지 않습니다: {video_id!r}")

    url = f"https://www.youtube.com/watch?v={video_id}"
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)

    ydl_opts = {
        "format": "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best",
        "outtmpl": str(out.with_suffix("")) + ".%(ext)s",
        "merge_output_format": "mp4",
        # 시스템에 ffmpeg 이 따로 설치되어 있지 않아도 되도록, 이미 프로젝트가
        # 의존하는 imageio_ffmpeg 번들 바이너리를 그대로 쓴다 (별도 분리 스트림
        # 병합에 필수).
        "ffmpeg_location": imageio_ffmpeg.get_ffmpeg_exe(),
        # 기본 web 클라이언트로 받은 포맷 URL은 서명/PO token 문제로 다운로드
        # 단계에서 403이 나는 경우가 흔하다. android/ios 클라이언트는 대체로
        # 서명 없이 바로 재생 가능한 URL을 준다.
        "extractor_args": {"youtube": {"player_client": ["android", "ios", "web"]}},
        "quiet": True,
        "noprogress": True,
        "noplaylist": True,
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
    except yt_dlp.utils.DownloadError as exc:
        raise RuntimeError(
            f"{exc}\n"
            "(참고: 유튜브가 403/포맷 오류를 계속 준다면 yt-dlp 버전이 오래됐을 "
            "가능성이 높습니다 — `uv sync -U` 로 yt-dlp 를 최신으로 올려보세요.)"
        ) from exc

    produced = out.with_suffix(".mp4")
    if not produced.is_file():
        raise RuntimeError(f"다운로드는 끝났지만 mp4 파일을 찾을 수 없습니다: {produced}")
    if produced != out:
        produced.replace(out)
    return str(out)
