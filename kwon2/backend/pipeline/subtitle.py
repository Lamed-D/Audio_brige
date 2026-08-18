"""원본 대사와 새로 생성한 화면해설을 하나의 타임라인으로 합쳐 SRT로 내보낸다.

manifest 의 segments 가 이미 "최종 자막 데이터"이지만, 그건 화면해설만 담은
JSON이라 원본 대사와 나란히 눈으로 검증하기 어렵다. 이 파일은 QA/검수용
산출물이며 /v1 API 로 서비스하지 않는다 — 원본 대사 텍스트를 공개 데이터로
내보내지 않는다는 원칙(연동규격 8.1)을 지키기 위해 항상 로컬 파일로만 쓴다.
"""

from __future__ import annotations

from typing import Iterable, Mapping


def _format_timestamp(ms: int) -> str:
    ms = max(int(ms), 0)
    hours, ms = divmod(ms, 3_600_000)
    minutes, ms = divmod(ms, 60_000)
    seconds, ms = divmod(ms, 1_000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{ms:03d}"


def build_srt(
    speech_segments: Iterable[Mapping[str, object]],
    narration_segments: Iterable[Mapping[str, object]],
) -> str:
    """speech_segments: [{"start_ms","end_ms","text"}], narration_segments: manifest["segments"]."""
    entries = []
    for s in speech_segments:
        text = str(s["text"]).strip()
        if text:
            entries.append((int(s["start_ms"]), int(s["end_ms"]), text))
    for seg in narration_segments:
        text = str(seg["text"]).strip()
        if text:
            start_ms = int(seg["trigger_ms"])
            end_ms = int(seg.get("deadline_ms", start_ms + int(seg["audio"]["duration_ms"])))
            entries.append((start_ms, end_ms, f"[화면해설] {text}"))

    entries.sort(key=lambda e: e[0])

    lines = []
    for index, (start_ms, end_ms, text) in enumerate(entries, start=1):
        lines.append(str(index))
        lines.append(f"{_format_timestamp(start_ms)} --> {_format_timestamp(end_ms)}")
        lines.append(text)
        lines.append("")
    return "\n".join(lines)
