from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from pathlib import Path

from .media import extract_audio_chunk, probe_duration


@dataclass(frozen=True)
class Interval:
    start: float
    end: float

    @property
    def duration(self) -> float:
        return self.end - self.start


def merge_intervals(intervals: list[Interval], join_gap: float = 0.4) -> list[Interval]:
    """서로 겹치거나 아주 가까운 음성 구간을 하나로 합친다."""
    if not intervals:
        return []

    ordered = sorted(intervals, key=lambda item: item.start)
    merged = [ordered[0]]
    for current in ordered[1:]:
        previous = merged[-1]
        if current.start <= previous.end + join_gap:
            merged[-1] = Interval(previous.start, max(previous.end, current.end))
        else:
            merged.append(current)
    return merged


def find_non_speech_gaps(
    speech: list[Interval],
    total_duration: float,
    min_gap: float = 2.0,
    safety_margin: float = 0.3,
    chars_per_second: float = 4.5,
) -> list[dict]:
    """음성 구간의 여집합에서 화면해설을 넣을 안전한 구간을 계산한다."""
    if total_duration <= 0:
        return []

    gaps: list[dict] = []
    cursor = 0.0
    boundaries = [*speech, Interval(total_duration, total_duration)]

    for item in boundaries:
        raw_start = cursor
        raw_end = min(item.start, total_duration)
        usable_start = raw_start + safety_margin
        usable_end = raw_end - safety_margin
        usable_duration = usable_end - usable_start

        if usable_duration >= min_gap:
            gaps.append(
                {
                    "id": f"gap_{len(gaps):03d}",
                    "start": round(usable_start, 3),
                    "end": round(usable_end, 3),
                    "duration": round(usable_duration, 3),
                    "max_chars": max(1, int(usable_duration * chars_per_second)),
                }
            )
        cursor = max(cursor, item.end)

    return gaps


def intervals_to_dicts(intervals: list[Interval]) -> list[dict]:
    return [asdict(item) for item in intervals]


class SpeechDetector:
    """faster-whisper 모델을 한 번만 로딩해 발화 구간과 대사를 찾는다."""

    def __init__(self, model_name: str = "small") -> None:
        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:
            raise RuntimeError(
                "faster-whisper가 없습니다. pip install -r requirements.txt 를 실행하세요."
            ) from exc

        self.model_name = model_name
        self.model = WhisperModel(model_name, device="cpu", compute_type="int8")

    def detect(self, audio_path: str) -> tuple[list[Interval], list[dict]]:
        segments, _ = self.model.transcribe(
            audio_path,
            language="ko",
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            word_timestamps=True,
        )

        intervals: list[Interval] = []
        transcript: list[dict] = []
        for segment in segments:
            start = float(segment.start)
            end = float(segment.end)
            text = segment.text.strip()
            intervals.append(Interval(start, end))
            transcript.append(
                {"start": round(start, 3), "end": round(end, 3), "text": text}
            )

        return merge_intervals(intervals), transcript


def _field(value: object, name: str, default: object = None) -> object:
    """OpenAI SDK 객체와 테스트용 dict 양쪽에서 값을 읽는다."""
    if isinstance(value, dict):
        return value.get(name, default)
    return getattr(value, name, default)


class OpenAISpeechDetector:
    """압축 오디오를 병렬 전사해 발화 시간과 자막을 만든다."""

    def __init__(
        self,
        model_name: str = "whisper-1",
        chunk_seconds: float = 120.0,
        max_workers: int = 3,
        language: str = "ko",
    ) -> None:
        if model_name != "whisper-1":
            raise ValueError(
                "현재 화면해설 파이프라인은 구간 타임스탬프가 필요한 관계로 "
                "OpenAI STT 모델에 whisper-1을 사용합니다."
            )
        self.model_name = model_name
        self.chunk_seconds = max(30.0, float(chunk_seconds))
        self.max_workers = max(1, int(max_workers))
        self.language = language
        self.provider_name = "openai"

    @property
    def cache_key(self) -> str:
        return (
            f"{self.provider_name}_{self.model_name}_"
            f"{self.chunk_seconds:g}_{self.language}_v1"
        )

    def _transcribe_chunk(self, path: Path, offset: float) -> list[dict]:
        from openai import OpenAI

        with path.open("rb") as audio_file:
            response = OpenAI().audio.transcriptions.create(
                file=audio_file,
                model=self.model_name,
                language=self.language,
                response_format="verbose_json",
                timestamp_granularities=["segment"],
            )

        transcript: list[dict] = []
        for segment in _field(response, "segments", []) or []:
            text = str(_field(segment, "text", "") or "").strip()
            start = float(_field(segment, "start", 0.0) or 0.0) + offset
            end = float(_field(segment, "end", 0.0) or 0.0) + offset
            if text and end > start:
                transcript.append(
                    {
                        "start": round(start, 3),
                        "end": round(end, 3),
                        "text": text,
                    }
                )
        return transcript

    def detect(self, audio_path: str) -> tuple[list[Interval], list[dict]]:
        source = Path(audio_path)
        duration = probe_duration(source)
        chunk_dir = source.parent / "stt_chunks"
        chunks: list[tuple[Path, float]] = []

        if duration <= self.chunk_seconds + 0.01:
            chunks.append((source, 0.0))
        else:
            chunk_dir.mkdir(parents=True, exist_ok=True)
            start = 0.0
            index = 0
            while start < duration - 0.01:
                chunk_duration = min(self.chunk_seconds, duration - start)
                chunk_path = chunk_dir / f"chunk_{index:03d}.mp3"
                extract_audio_chunk(source, start, chunk_duration, chunk_path)
                chunks.append((chunk_path, start))
                start += chunk_duration
                index += 1

        pieces: list[dict] = []
        worker_count = min(self.max_workers, len(chunks))
        with ThreadPoolExecutor(max_workers=worker_count) as executor:
            futures = {
                executor.submit(self._transcribe_chunk, path, offset): offset
                for path, offset in chunks
            }
            for future in as_completed(futures):
                pieces.extend(future.result())

        transcript = sorted(pieces, key=lambda item: (item["start"], item["end"]))
        intervals = [
            Interval(float(item["start"]), float(item["end"]))
            for item in transcript
        ]
        return merge_intervals(intervals), transcript
