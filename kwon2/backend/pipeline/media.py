"""M1: 로컬 영상 파일에서 오디오 전체와 gap 프레임을 뽑는다.

원본 영상 파일이나 프레임을 공개 API로 서비스하지 않는다(연동규격 8.1). 이 모듈은
파이프라인 실행 중에만 임시 디렉터리에 결과물을 두고, 결과는 텍스트(script)와
합성 음성으로만 다음 단계에 넘어간다.
"""

from __future__ import annotations

import subprocess
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, List

import cv2
import imageio_ffmpeg
import numpy as np
import soundfile as sf

import config
from pipeline.gaps import Gap


_FRAME_ROLE_RE = re.compile(r"_(before|gap|after)_t\d+_")


def _frame_role(path: str) -> str:
    match = _FRAME_ROLE_RE.search(Path(path).name)
    return match.group(1) if match else "unknown"


@dataclass(frozen=True)
class FrameSimilarityDecision:
    frame: str
    compared_to: str | None
    similarity: float | None
    action: str  # "keep" | "replace_similar"


def _read_image(path: str):
    """Windows의 한글 경로에서도 동작하는 OpenCV 이미지 읽기."""
    try:
        encoded = np.fromfile(path, dtype=np.uint8)
    except OSError as exc:
        raise RuntimeError(f"프레임 파일을 읽을 수 없습니다: {path}: {exc}") from exc
    if encoded.size == 0:
        raise RuntimeError(f"프레임 파일이 비어 있습니다: {path}")
    image = cv2.imdecode(encoded, cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise RuntimeError(f"프레임 이미지를 디코딩할 수 없습니다: {path}")
    return image


def _write_jpeg(path: str, frame) -> None:
    """cv2.imwrite가 처리하지 못하는 Windows 유니코드 경로에 JPEG를 저장한다."""
    ok, encoded = cv2.imencode(".jpg", frame)
    if not ok:
        raise RuntimeError(f"프레임 JPEG 인코딩에 실패했습니다: {path}")
    try:
        encoded.tofile(path)
    except OSError as exc:
        raise RuntimeError(f"프레임 파일 저장에 실패했습니다: {path}: {exc}") from exc


def _frame_fingerprint(path: str) -> tuple[object, object]:
    """압축 노이즈에는 둔감하고 작은 글자 변화에는 민감한 로컬 지문을 만든다."""
    gray = _read_image(path)
    small = cv2.resize(gray, (64, 36), interpolation=cv2.INTER_AREA)
    dhash_source = cv2.resize(gray, (9, 8), interpolation=cv2.INTER_AREA)
    dhash = dhash_source[:, 1:] > dhash_source[:, :-1]
    return small, dhash


def frame_similarity(left_path: str, right_path: str) -> float:
    """0~1 유사도. 픽셀과 dHash 중 더 보수적인 값으로 작은 자막 변화를 살린다."""
    return _fingerprint_similarity(
        _frame_fingerprint(left_path), _frame_fingerprint(right_path)
    )


def _fingerprint_similarity(left: tuple[object, object], right: tuple[object, object]) -> float:
    left_small, left_hash = left
    right_small, right_hash = right
    pixel_similarity = 1.0 - float(cv2.absdiff(left_small, right_small).mean()) / 255.0
    hash_similarity = 1.0 - float((left_hash != right_hash).mean())
    return max(0.0, min(1.0, min(pixel_similarity, hash_similarity)))


def filter_similar_frames(
    frame_paths: List[str], threshold: float | None = None
) -> tuple[List[str], List[dict[str, Any]]]:
    """한 gap의 유사 프레임을 하나로 줄이고 각 묶음의 마지막 프레임을 남긴다.

    시작/중간/끝 캡처는 그대로 보존한다. 여기서는 API 전송 후보만 줄이므로 원본
    jpg는 작업 폴더에 남아 있고, 선택 과정도 JSON 로그로 검증할 수 있다.
    """
    threshold = config.FRAME_SIMILARITY_THRESHOLD if threshold is None else threshold
    if not 0 <= threshold <= 1:
        raise ValueError("threshold는 0~1 범위여야 합니다")
    if not frame_paths:
        return [], []

    selected: list[tuple[int, str]] = [(0, frame_paths[0])]
    fingerprints = {path: _frame_fingerprint(path) for path in frame_paths}
    decisions = [
        asdict(FrameSimilarityDecision(frame_paths[0], None, None, "keep"))
    ]
    for frame_index, path in enumerate(frame_paths[1:], start=1):
        role = _frame_role(path)
        comparable = [
            (selected_index, kept_path)
            for selected_index, (_, kept_path) in enumerate(selected)
            if _frame_role(kept_path) == role
        ]
        comparisons = [
            _fingerprint_similarity(fingerprints[kept_path], fingerprints[path])
            for _, kept_path in comparable
        ]
        if not comparisons:
            selected.append((frame_index, path))
            decisions.append(
                asdict(FrameSimilarityDecision(path, None, None, "keep"))
            )
            continue
        comparison_index = max(range(len(comparisons)), key=comparisons.__getitem__)
        matched_index = comparable[comparison_index][0]
        similarity = comparisons[comparison_index]
        previous = selected[matched_index][1]
        if similarity >= threshold:
            # 글자가 점진적으로 나타나는 경우 묶음의 마지막(가장 완성된) 화면을 대표로 쓴다.
            selected.pop(matched_index)
            selected.append((frame_index, path))
            action = "replace_similar"
        else:
            selected.append((frame_index, path))
            action = "keep"
        decisions.append(
            asdict(
                FrameSimilarityDecision(
                    frame=path,
                    compared_to=previous,
                    similarity=round(similarity, 6),
                    action=action,
                )
            )
        )
    selected.sort(key=lambda item: item[0])
    return [path for _, path in selected], decisions


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
    """gap의 앞·내부·뒤 장면을 시간순으로 캡처한다. gap index -> [frame_path, ...].

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
    fps = cap.get(cv2.CAP_PROP_FPS) or 0
    frame_count = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    video_duration_ms = round(frame_count * 1000 / fps) if fps > 0 else max((g.end_ms for g in gaps), default=0)
    try:
        for gap_index, gap in enumerate(gaps):
            paths = []
            context_ms = config.GAP_CONTEXT_WINDOW_MS
            requested: list[tuple[float, str]] = [
                (max(0, gap.start_ms - context_ms), "before"),
                (max(0, gap.start_ms - context_ms / 2), "before"),
            ]
            for window_start, window_end in _second_windows_ms(gap.start_ms, gap.end_ms):
                mid_ms = (window_start + window_end) / 2
                for t_ms in (window_start, mid_ms, window_end):
                    requested.append((t_ms, "gap"))
            requested.extend(
                [
                    (min(video_duration_ms, gap.end_ms + context_ms / 2), "after"),
                    (min(video_duration_ms, gap.end_ms + context_ms), "after"),
                ]
            )
            seen_times: set[int] = set()
            for t_ms, role in sorted(requested, key=lambda item: item[0]):
                rounded_ms = max(0, min(round(t_ms), video_duration_ms))
                if rounded_ms in seen_times:
                    continue
                seen_times.add(rounded_ms)
                cap.set(cv2.CAP_PROP_POS_MSEC, rounded_ms)
                ret, frame = cap.read()
                if not ret:
                    continue
                filename = f"gap_{gap_index:03d}_{role}_t{rounded_ms:09d}_{saved_idx:05d}.jpg"
                path = str(Path(output_dir) / filename)
                _write_jpeg(path, frame)
                paths.append(path)
                saved_idx += 1
            frames_by_gap[gap_index] = paths
    finally:
        cap.release()
    return frames_by_gap


def capture_overview_frames(
    video_path: str,
    duration_ms: int,
    output_dir: str,
) -> List[str]:
    """인물 소개·명찰·반복 배경을 파악할 영상 전체 대표 프레임을 만든다."""
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"영상을 열 수 없습니다: {video_path}")
    interval_ms = config.OVERVIEW_FRAME_INTERVAL_SEC * 1000
    times = {0, min(5_000, duration_ms), min(10_000, duration_ms)}
    times.update(range(0, duration_ms + 1, interval_ms))
    ordered = sorted(times)
    if len(ordered) > config.MAX_OVERVIEW_FRAMES:
        # 영상 앞부분만 남지 않도록 처음부터 끝까지 균등하게 뽑는다.
        if config.MAX_OVERVIEW_FRAMES == 1:
            ordered = [ordered[len(ordered) // 2]]
        else:
            step = (len(ordered) - 1) / (config.MAX_OVERVIEW_FRAMES - 1)
            ordered = [
                ordered[round(index * step)]
                for index in range(config.MAX_OVERVIEW_FRAMES)
            ]
    paths: List[str] = []
    try:
        for index, t_ms in enumerate(ordered):
            cap.set(cv2.CAP_PROP_POS_MSEC, t_ms)
            ret, frame = cap.read()
            if not ret:
                continue
            path = str(Path(output_dir) / f"overview_t{t_ms:09d}_{index:03d}.jpg")
            _write_jpeg(path, frame)
            paths.append(path)
    finally:
        cap.release()
    return paths
