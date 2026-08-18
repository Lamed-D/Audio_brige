"""M1: 로컬 영상 파일에서 오디오 전체와 gap 프레임을 뽑는다.

원본 영상 파일이나 프레임을 공개 API로 서비스하지 않는다(연동규격 8.1). 이 모듈은
파이프라인 실행 중에만 임시 디렉터리에 결과물을 두고, 결과는 텍스트(script)와
합성 음성으로만 다음 단계에 넘어간다.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import List

import cv2
import imageio_ffmpeg
import soundfile as sf

import config
from pipeline.gaps import Gap


def extract_audio(video_path: str, output_wav_path: str) -> str:
    ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
    Path(output_wav_path).parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        ffmpeg_exe, "-y", "-i", video_path,
        "-vn", "-ac", "1", "-ar", str(config.AUDIO_SAMPLE_RATE),
        "-acodec", "pcm_s16le", output_wav_path,
    ]
    result = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg 오디오 추출 실패: {result.stderr.decode(errors='ignore')}")
    return output_wav_path


def audio_duration_ms(wav_path: str) -> int:
    return round(sf.info(wav_path).duration * 1000)


def _second_windows_ms(start_ms: int, end_ms: int):
    """gap 을 1초 단위 창으로 나눈다. 마지막 창은 gap 끝에서 잘린다."""
    t = start_ms
    while t < end_ms:
        window_end = min(t + 1000, end_ms)
        yield t, window_end
        t = window_end


def capture_gap_frames(video_path: str, gaps: List[Gap], output_dir: str) -> dict[int, List[str]]:
    """gap 안의 1초마다 시작·중간·끝 3장씩 캡처한다. gap index -> [frame_path, ...].

    긴 무음 구간일수록 장면이 여러 번 바뀔 수 있어서, gap 전체에서 3장만 뽑으면
    중간 변화를 놓친다. 초 단위로 나눠 촘촘히 캡처해 두고, 실제로 모델에 보낼
    개수는 narrate.py 가 config.MAX_*_FRAMES_PER_GAP 만큼 골라 쓴다.
    """
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"영상을 열 수 없습니다: {video_path}")

    frames_by_gap: dict[int, List[str]] = {}
    saved_idx = 0
    try:
        for gap_index, gap in enumerate(gaps):
            paths = []
            for window_start, window_end in _second_windows_ms(gap.start_ms, gap.end_ms):
                mid_ms = (window_start + window_end) / 2
                for t_ms in (window_start, mid_ms, window_end):
                    cap.set(cv2.CAP_PROP_POS_MSEC, max(t_ms, 0))
                    ret, frame = cap.read()
                    if not ret:
                        continue
                    filename = f"frame_{saved_idx:05d}.jpg"
                    path = str(Path(output_dir) / filename)
                    cv2.imwrite(path, frame)
                    paths.append(path)
                    saved_idx += 1
            frames_by_gap[gap_index] = paths
    finally:
        cap.release()
    return frames_by_gap
