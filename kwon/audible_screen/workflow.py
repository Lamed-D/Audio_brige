from __future__ import annotations

import hashlib
import json
import math
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path
from typing import Callable

from PIL import Image

from .media import (
    capture_frame,
    extract_audio_track,
    extract_speech_audio,
    mix_narrations_with_video,
    probe_duration,
    require_media_tools,
)
from .speech import Interval, find_non_speech_gaps, intervals_to_dicts
from .subtitles import accessible_subtitle_entries, speech_subtitle_entries, write_srt
from .tts import SpeechSynthesizer
from .vision import SceneAnalyzer, normalize_text


LogFn = Callable[[str], None]
ProgressFn = Callable[[int, int], None]


@dataclass(frozen=True)
class AnalysisConfig:
    min_gap: float = 2.0
    safety_margin: float = 0.3
    chars_per_second: float = 2.8
    max_gaps: int = 20
    candidate_frames: int = 7
    max_keyframes: int = 4
    scene_change_threshold: float = 0.055
    vision_workers: int = 3
    tts_workers: int = 3
    make_output_video: bool = True
    max_duration_seconds: float = 15 * 60


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def sample_gap_times(start: float, end: float, count: int = 3) -> list[float]:
    """전환 초반보다 완성 시점에 비중을 둔 시간순 샘플을 만든다."""
    if end <= start:
        raise ValueError("gap의 end는 start보다 커야 합니다.")
    if count < 1:
        raise ValueError("frame_count는 1 이상이어야 합니다.")
    if count == 1:
        return [round((start + end) / 2, 3)]

    preferred = [0.20, 0.60, 0.90]
    if count == 3:
        fractions = preferred
    else:
        fractions = [0.08 + (0.84 * index / (count - 1)) for index in range(count)]
    duration = end - start
    return [round(start + duration * fraction, 3) for fraction in fractions]


def sample_triplets_per_second(start: float, end: float) -> list[float]:
    """이전 결과 파일을 읽는 코드와의 호환을 위해 남겨 둔 샘플 함수다."""
    if end <= start:
        raise ValueError("구간의 end는 start보다 커야 합니다.")
    points: list[float] = []
    second = math.floor(start)
    while second < end:
        slice_start = max(start, float(second))
        slice_end = min(end, float(second + 1))
        duration = slice_end - slice_start
        if duration > 0.001:
            for fraction in (0.05, 0.50, 0.95):
                points.append(round(slice_start + duration * fraction, 3))
        second += 1
    return points


def split_gap_windows(gap: dict, max_seconds: float) -> list[dict]:
    """이전 API와의 호환용 함수. 새 분석은 원래 gap을 나누지 않는다."""
    if max_seconds <= 0:
        raise ValueError("max_seconds는 0보다 커야 합니다.")
    start = float(gap["start"])
    end = float(gap["end"])
    windows: list[dict] = []
    cursor = start
    while cursor < end - 0.001:
        window_end = min(cursor + max_seconds, end)
        if end - window_end < 0.75:
            window_end = end
        duration = window_end - cursor
        windows.append(
            {
                **gap,
                "id": f"{gap['id']}_part_{len(windows) + 1:02d}",
                "parent_gap_id": gap["id"],
                "start": round(cursor, 3),
                "end": round(window_end, 3),
                "duration": round(duration, 3),
                "max_chars": max(1, int(duration * 2.8)),
            }
        )
        cursor = window_end
    return windows


def select_gaps(gaps: list[dict], max_gaps: int) -> list[dict]:
    """영상 전체 시간대가 빠지지 않도록 균등하게 gap을 고른다."""
    if max_gaps <= 0:
        return []
    if len(gaps) <= max_gaps:
        return list(gaps)
    if max_gaps == 1:
        return [max(gaps, key=lambda item: float(item["duration"]))]

    indices = {
        round(position * (len(gaps) - 1) / (max_gaps - 1))
        for position in range(max_gaps)
    }
    return [gaps[index] for index in sorted(indices)]


def nearby_captions(transcript: list[dict], gap: dict) -> list[dict]:
    """지시어와 앞 장면 참조를 판단할 수 있도록 앞뒤 자막을 보존한다."""
    lower = float(gap["start"]) - 20.0
    upper = float(gap["end"]) + 8.0
    context: list[dict] = []
    for item in transcript:
        start = float(item["start"])
        end = float(item["end"])
        if end < lower or start > upper or not item.get("text"):
            continue
        if end <= float(gap["start"]):
            relation = "before"
        elif start >= float(gap["end"]):
            relation = "after"
        else:
            relation = "overlap"
        context.append({**item, "relation": relation})
    return context[-20:]


def _image_signature(path: Path) -> list[int]:
    with Image.open(path) as image:
        gray = image.convert("L").resize((32, 18))
        return list(gray.tobytes())


def _signature_difference(left: list[int], right: list[int]) -> float:
    return sum(abs(a - b) for a, b in zip(left, right)) / (255 * len(left))


def select_keyframes(
    frame_paths: list[Path],
    frame_times: list[float],
    max_frames: int = 4,
    scene_change_threshold: float = 0.055,
) -> tuple[list[Path], list[float]]:
    """처음·중간·완성 시점을 보존하고 큰 화면 변화만 추가한다."""
    if len(frame_paths) != len(frame_times) or not frame_paths:
        raise ValueError("프레임 경로와 시각은 같은 개수로 한 개 이상 필요합니다.")
    limit = max(1, min(int(max_frames), len(frame_paths)))
    if len(frame_paths) <= limit:
        return list(frame_paths), list(frame_times)

    signatures = [_image_signature(path) for path in frame_paths]
    required = [0, len(frame_paths) // 2, len(frame_paths) - 1]
    selected = set(required[:limit])
    changes = sorted(
        (
            (_signature_difference(signatures[index - 1], signatures[index]), index)
            for index in range(1, len(frame_paths))
        ),
        reverse=True,
    )
    for difference, index in changes:
        if len(selected) >= limit:
            break
        if difference >= scene_change_threshold:
            selected.add(index)

    if len(selected) < limit and limit >= 4:
        for index in reversed(range(len(frame_paths))):
            if index not in selected:
                selected.add(index)
                break
    ordered = sorted(selected)
    return [frame_paths[index] for index in ordered], [frame_times[index] for index in ordered]


def file_fingerprint(path: Path) -> str:
    """전체 대용량 파일을 다시 읽지 않고 캐시용 지문을 만든다."""
    stat = path.stat()
    digest = hashlib.sha256()
    digest.update(str(stat.st_size).encode("ascii"))
    with path.open("rb") as source:
        digest.update(source.read(1024 * 1024))
        if stat.st_size > 1024 * 1024:
            source.seek(max(0, stat.st_size - 1024 * 1024))
            digest.update(source.read(1024 * 1024))
    return digest.hexdigest()


def load_speech_cache(path: Path) -> tuple[list[Interval], list[dict]] | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        speech = [
            Interval(float(item["start"]), float(item["end"]))
            for item in data["speech"]
        ]
        return speech, list(data["transcript"])
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
        return None


def narration_similarity(left: str, right: str) -> float:
    a = normalize_text(left)
    b = normalize_text(right)
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def remove_adjacent_duplicates(results: list[dict], max_distance: float = 15.0) -> None:
    accepted: list[dict] = []
    for item in results:
        narration = str(item.get("narration", ""))
        if not narration:
            continue
        duplicate = next(
            (
                previous
                for previous in reversed(accepted[-2:])
                if float(item["start"]) - float(previous["end"]) <= max_distance
                and narration_similarity(narration, str(previous["narration"])) >= 0.68
            ),
            None,
        )
        if duplicate is not None:
            item.update(
                source="skip",
                narration="",
                confidence="low",
                validation="rejected_adjacent_duplicate",
                reason=f"{duplicate['id']}와 비슷한 해설이라 중복 제거",
            )
        else:
            accepted.append(item)


def _failed_analysis(message: str, frame_count: int = 0) -> dict:
    return {
        "frame_texts": [""] * frame_count,
        "stable_text": "",
        "new_screen_text": "",
        "resolved_reference": "",
        "scene_description": "",
        "narration": "",
        "source": "skip",
        "confidence": "low",
        "reason": message,
        "validation": "analysis_error",
    }


def analyze_video(
    video_path: Path,
    job_dir: Path,
    detector: object,
    analyzer: SceneAnalyzer,
    config: AnalysisConfig,
    log: LogFn,
    progress: ProgressFn | None = None,
    synthesizer: SpeechSynthesizer | None = None,
    cache_dir: Path | None = None,
) -> dict:
    require_media_tools()
    frames_dir = job_dir / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)

    duration = probe_duration(video_path)
    if duration > config.max_duration_seconds:
        raise RuntimeError(
            f"영상이 {duration / 60:.1f}분입니다. 현재 테스트 제한은 "
            f"{config.max_duration_seconds / 60:.0f}분입니다."
        )
    log(f"영상 길이: {duration:.1f}초")

    detector_name = str(getattr(detector, "model_name", "unknown"))
    detector_cache_key = str(getattr(detector, "cache_key", detector_name))
    cache_path: Path | None = None
    cached = None
    if cache_dir is not None:
        speech_cache_dir = cache_dir / "speech"
        speech_cache_dir.mkdir(parents=True, exist_ok=True)
        cache_path = (
            speech_cache_dir
            / f"{file_fingerprint(video_path)}_{detector_cache_key}.json"
        )
        cached = load_speech_cache(cache_path)

    if cached is not None:
        speech, transcript = cached
        log("같은 영상의 음성 분석 캐시를 사용합니다.")
        speech_cache_hit = True
    else:
        suffix = (
            ".mp3"
            if getattr(detector, "provider_name", "local") == "openai"
            else ".wav"
        )
        speech_audio = job_dir / f"speech_audio{suffix}"
        log("영상에서 압축 음성 분석용 오디오를 추출합니다.")
        extract_speech_audio(video_path, speech_audio)
        log(f"{detector_name} 모델로 사람 발화 구간을 찾습니다.")
        speech, transcript = detector.detect(str(speech_audio))
        speech_cache_hit = False
        if cache_path is not None:
            write_json(
                cache_path,
                {"speech": intervals_to_dicts(speech), "transcript": transcript},
            )

    speech_srt = job_dir / "speech.srt"
    write_srt(speech_srt, speech_subtitle_entries(transcript))
    log("음성 자막 파일을 만들었습니다: speech.srt")

    gaps = find_non_speech_gaps(
        speech,
        total_duration=duration,
        min_gap=config.min_gap,
        safety_margin=config.safety_margin,
        chars_per_second=config.chars_per_second,
    )
    selected = select_gaps(gaps, config.max_gaps)
    log(f"발화 구간 {len(speech)}개, 유효 gap {len(gaps)}개를 찾았습니다.")
    if len(selected) < len(gaps):
        log(f"영상 전체에 고르게 분포한 gap {len(selected)}개를 분석합니다.")

    segments = {
        "duration": round(duration, 3),
        "transcript": transcript,
        "speech": intervals_to_dicts(speech),
        "all_gaps": gaps,
        "selected_gaps": selected,
    }
    write_json(job_dir / "segments.json", segments)

    prepared: list[dict] = []
    total = len(selected)
    for index, gap in enumerate(selected, start=1):
        log(f"[{index}/{total}] {gap['id']} 핵심 프레임 후보를 캡처합니다.")
        candidate_times = sample_gap_times(
            float(gap["start"]), float(gap["end"]), config.candidate_frames
        )
        candidate_paths: list[Path] = []
        for frame_index, timestamp in enumerate(candidate_times, start=1):
            path = frames_dir / f"{gap['id']}_candidate_{frame_index:02d}.jpg"
            capture_frame(video_path, timestamp, path)
            candidate_paths.append(path)
        frame_paths, frame_times = select_keyframes(
            candidate_paths,
            candidate_times,
            config.max_keyframes,
            config.scene_change_threshold,
        )
        for path in candidate_paths:
            if path not in frame_paths:
                path.unlink(missing_ok=True)
        log(
            f"[{index}/{total}] 후보 {len(candidate_paths)}장 중 핵심 "
            f"{len(frame_paths)}장만 선택했습니다."
        )
        prepared.append(
            {
                "gap": gap,
                "frame_paths": frame_paths,
                "frame_times": frame_times,
                "captions": nearby_captions(transcript, gap),
            }
        )

    indexed_results: dict[int, dict] = {}
    if prepared:
        log(f"Vision 분석을 최대 {config.vision_workers}개씩 병렬 처리합니다.")
        workers = min(max(1, config.vision_workers), len(prepared))
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {
                executor.submit(
                    analyzer.analyze_with_fallback,
                    item["frame_paths"],
                    item["frame_times"],
                    item["gap"],
                    item["captions"],
                ): index
                for index, item in enumerate(prepared)
            }
            completed = 0
            for future in as_completed(futures):
                item_index = futures[future]
                item = prepared[item_index]
                gap = item["gap"]
                try:
                    analysis = future.result()
                except Exception as exc:
                    analysis = _failed_analysis(
                        f"분석 실패: {exc}", len(item["frame_paths"])
                    )
                indexed_results[item_index] = {
                    **gap,
                    "frame_times": item["frame_times"],
                    "frames": [str(path) for path in item["frame_paths"]],
                    **analysis,
                }
                completed += 1
                log(
                    f"[{completed}/{total}] {gap['id']} "
                    f"source={analysis['source']} confidence={analysis['confidence']} "
                    f"narration={analysis['narration'] or '(건너뜀)'}"
                )
                if progress:
                    progress(completed, total)

    results = [indexed_results[index] for index in sorted(indexed_results)]
    remove_adjacent_duplicates(results)
    write_json(job_dir / "script.json", results)

    if synthesizer is not None:
        tts_dir = job_dir / "tts"
        tts_dir.mkdir(parents=True, exist_ok=True)
        narration_items = [item for item in results if item.get("narration")]
        log(f"화면해설 {len(narration_items)}개를 TTS로 병렬 생성합니다.")
        for item in results:
            item["tts_status"] = "skipped"
            item["clip"] = ""
        if narration_items:
            workers = min(max(1, config.tts_workers), len(narration_items))
            with ThreadPoolExecutor(max_workers=workers) as executor:
                futures = {
                    executor.submit(
                        synthesizer.fit_to_gap,
                        str(item["narration"]),
                        float(item["duration"]),
                        tts_dir / f"{item['id']}.wav",
                    ): item
                    for item in narration_items
                }
                for future in as_completed(futures):
                    item = futures[future]
                    try:
                        fitted = future.result()
                        if fitted is None:
                            item["tts_status"] = "too_long"
                            log(f"{item['id']}: TTS를 안전한 길이로 맞추지 못했습니다.")
                            continue
                        fitted_text, actual_duration, clip_path = fitted
                        item["narration"] = fitted_text
                        item["tts_duration"] = round(actual_duration, 3)
                        item["tts_status"] = "ready"
                        item["clip"] = str(clip_path)
                    except Exception as exc:
                        item["tts_status"] = "error"
                        item["tts_error"] = str(exc)
                        log(f"{item['id']}: TTS 생성 실패 - {exc}")
        write_json(job_dir / "script.json", results)

    accessible_srt = job_dir / "accessible.srt"
    write_srt(accessible_srt, accessible_subtitle_entries(transcript, results))

    output_video: Path | None = None
    output_audio: Path | None = None
    ready_tts = [item for item in results if item.get("tts_status") == "ready"]
    if ready_tts and config.make_output_video:
        output_video = job_dir / "accessible_video.mp4"
        output_audio = job_dir / "accessible_audio.m4a"
        log("원본 소리와 화면해설 TTS를 합쳐 접근성 영상을 만듭니다.")
        mix_narrations_with_video(video_path, ready_tts, output_video)
        extract_audio_track(output_video, output_audio)
        log("접근성 영상과 음성 파일을 만들었습니다.")

    summary = {
        "video_path": str(video_path),
        "job_dir": str(job_dir),
        "duration": round(duration, 3),
        "speech_model": detector_name,
        "speech_cache_hit": speech_cache_hit,
        "speech_count": len(speech),
        "gap_count": len(gaps),
        "analyzed_count": len(results),
        "speech_srt": str(speech_srt),
        "accessible_srt": str(accessible_srt),
        "output_video": str(output_video) if output_video else "",
        "output_audio": str(output_audio) if output_audio else "",
        "results": results,
    }
    write_json(job_dir / "result.json", summary)
    log("자막·화면해설 분석을 완료했습니다.")
    return summary
