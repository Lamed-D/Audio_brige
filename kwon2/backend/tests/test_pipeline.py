from __future__ import annotations

import subprocess
import wave
from pathlib import Path

import imageio_ffmpeg
import pytest

from adapters.base import (
    DescribeResult,
    ReadTextResult,
    SpeechClip,
    SpeechSegment,
    TranscribeResult,
    Word,
)
from core.storage import FileRepository
from pipeline.build_manifest import run_pipeline
from tests.conftest import write_catalog


class FakeAdapter:
    """1초 발화 - 3초 무음 - 2초 발화 형태의 합성 영상에 맞춘 고정 응답 어댑터."""

    def transcribe(self, audio_path: str, language: str = "ko") -> TranscribeResult:
        words = [Word(0.0, 1.0, "안녕"), Word(4.0, 6.0, "하세요")]
        segments = [SpeechSegment(0.0, 1.0, "안녕"), SpeechSegment(4.0, 6.0, "하세요")]
        return TranscribeResult(duration=6.0, words=words, segments=segments)

    def read_text(self, image_path: str) -> ReadTextResult:
        return ReadTextResult(text="", confidence="low")

    def describe(self, image_paths, context, max_chars: int) -> DescribeResult:
        return DescribeResult(text="문에서 사람이 나온다"[:max_chars], confidence="high")

    def speak(self, text: str, output_path: str, speed: float = 1.0) -> SpeechClip:
        with wave.open(output_path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(22050)
            w.writeframes(b"\x00\x00" * 22050)  # 1초짜리 무음 더미 클립
        return SpeechClip(path=output_path, duration=1.0)


@pytest.fixture(scope="module")
def synthetic_video(tmp_path_factory) -> str:
    """1초 톤 - 3초 무음 - 2초 톤 오디오를 실제 프레임이 있는 mp4 로 만든다."""
    path = tmp_path_factory.mktemp("media") / "synthetic.mp4"
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    cmd = [
        ffmpeg, "-y",
        "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=6",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
        "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono:duration=3",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
        "-filter_complex", "[1][2][3]concat=n=3:v=0:a=1[a]",
        "-map", "0:v", "-map", "[a]",
        "-c:v", "libx264", "-c:a", "aac", "-shortest", str(path),
    ]
    result = subprocess.run(cmd, capture_output=True)
    assert result.returncode == 0, result.stderr.decode(errors="ignore")
    return str(path)


def test_run_pipeline_publishes_playable_manifest(tmp_path: Path, synthetic_video: str):
    data_dir = tmp_path / "data"
    write_catalog(
        data_dir,
        videos=[{"provider": "youtube", "video_id": "test1", "duration_ms": 6000, "enabled": True}],
    )
    repository = FileRepository(data_dir)

    runs_dir = tmp_path / "runs"
    result = run_pipeline(
        "youtube", "test1", synthetic_video, repository, FakeAdapter(), runs_dir=runs_dir
    )

    assert result["gaps_total"] == 1
    assert result["segments_published"] == 1
    assert result["segments_skipped"] == 0
    assert result["frames_captured"] >= result["frames_selected"] >= 1
    assert result["frames_removed"] == result["frames_captured"] - result["frames_selected"]

    manifest = result["manifest"]
    segment = manifest["segments"][0]
    assert segment["text"]
    assert segment["source"] == "vlm"
    assert manifest["schema_version"] == "1.1"
    assert segment["mode"] in {"overlay", "extended"}
    if segment["mode"] == "overlay":
        assert segment["audio"]["duration_ms"] <= segment["deadline_ms"] - segment["trigger_ms"]
    else:
        assert segment["audio"]["duration_ms"] <= manifest["playback"]["max_extended_duration_ms"]

    # /v1 API 가 실제로 서비스할 때 쓰는 것과 같은 읽기 경로로 재검증한다.
    record = repository.find_manifest("youtube", "test1")
    assert record is not None
    assert record.data == manifest

    # M1~M4 중간 산출물과 로그가 실제로 남았는지 확인한다 — 이게 이번 개편의 핵심이다.
    run_dir = Path(result["run_dir"])
    assert run_dir == runs_dir / "youtube" / "test1" / "r1"
    assert (run_dir / "audio.wav").is_file()
    assert list((run_dir / "frames").glob("*.jpg"))
    assert (run_dir / "pipeline.log").read_text(encoding="utf-8").strip()
    assert (run_dir / "frame_selection.json").is_file()
    assert (run_dir / "program_context.json").is_file()
    assert list((run_dir / "overview_frames").glob("*.jpg"))
    frame_names = [path.name for path in (run_dir / "frames").glob("*.jpg")]
    assert any("_before_" in name for name in frame_names)
    assert any("_gap_" in name for name in frame_names)
    assert any("_after_" in name for name in frame_names)

    import json as _json

    segments_doc = _json.loads((run_dir / "segments.json").read_text(encoding="utf-8"))
    assert segments_doc["duration_ms"] > 0
    assert len(segments_doc["gaps"]) == 1

    script_doc = _json.loads((run_dir / "script.json").read_text(encoding="utf-8"))
    assert len(script_doc) == 1
    assert script_doc[0]["status"] == "published"
    assert script_doc[0]["segment_id"] == "seg-001"

    ocr_doc = _json.loads((run_dir / "ocr.json").read_text(encoding="utf-8"))
    assert isinstance(ocr_doc, list)  # OCR 은 빈 텍스트라 describe 로 넘어갔어도 시도 기록은 남는다


def test_run_pipeline_auto_registers_unknown_video(tmp_path: Path, synthetic_video: str):
    """카탈로그에 미리 등록하지 않은 video_id 도 실측 길이로 자동 등록되고 처리된다.

    사전 등록을 요구하면 '영상 한 편을 처리한다'는 목적에 비해 불필요한 수작업이
    생긴다 — /dev/process 의 동작과 CLI 를 일치시킨다.
    """
    data_dir = tmp_path / "data"
    write_catalog(data_dir, videos=[])  # 아무것도 등록되어 있지 않다
    repository = FileRepository(data_dir)

    assert repository.get_catalog_video("youtube", "new-video") is None

    result = run_pipeline(
        "youtube", "new-video", synthetic_video, repository, FakeAdapter(), runs_dir=tmp_path / "runs"
    )

    assert result["segments_published"] == 1
    registered = repository.get_catalog_video("youtube", "new-video")
    assert registered is not None
    assert registered.duration_ms == result["manifest"]["video"]["duration_ms"]


def test_run_pipeline_corrects_unpublished_browser_duration_hint(
    tmp_path: Path, synthetic_video: str
):
    """게시 전 브라우저 길이는 힌트이며 다운로드 실측값으로 교정한다."""
    data_dir = tmp_path / "data"
    write_catalog(
        data_dir,
        videos=[
            {
                "provider": "youtube",
                "video_id": "playlist-video",
                "duration_ms": 37_901,
                "enabled": True,
            }
        ],
    )
    repository = FileRepository(data_dir)

    result = run_pipeline(
        "youtube",
        "playlist-video",
        synthetic_video,
        repository,
        FakeAdapter(),
        runs_dir=tmp_path / "runs",
    )

    registered = repository.get_catalog_video("youtube", "playlist-video")
    assert registered is not None
    assert registered.duration_ms == result["manifest"]["video"]["duration_ms"]
    assert registered.duration_ms != 37_901
