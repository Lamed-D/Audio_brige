"""M3+M4: OCR 우선, VLM 보조로 gap 하나의 서술 텍스트를 결정한다.

core.narrator 는 실시간 세션(SessionState) 기준으로 같은 규칙을 구현한다. 이
모듈은 세션 상태 없이 배치 인자만으로 동일한 우선순위·중복·확신도 규칙을
적용한다 — "OCR 우선, VLM 보조, 길이·중복·확신도 검증" (연동규격 BE-04).

모든 시도를 NarrateTrace 에 남긴다 — 채택된 것만 기억하면 나중에 "왜 이 gap 은
skip 됐는가"를 알 방법이 없다. build_manifest.py 가 이 trace 를 ocr.json/
script.json 으로 그대로 저장한다.
"""

from __future__ import annotations

import difflib
import re
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

import config
from adapters.base import ModelAdapter


def _normalize(text: str) -> str:
    return re.sub(r"[\s\.,!?~\-\"'·…]", "", text)


def _similar(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, _normalize(a), _normalize(b)).ratio()


def _is_duplicate(text: str, *text_lists: List[str]) -> bool:
    for texts in text_lists:
        for other in texts[-5:]:
            if _similar(text, other) >= config.DUPLICATE_SIMILARITY_THRESHOLD:
                return True
    return False


def _pick_frames(frame_paths: List[str], limit: int) -> List[str]:
    """gap 안에서 초 단위로 촘촘히 캡처된 프레임 중, 시간축에 고르게 퍼진
    limit 장만 골라 모델 호출 비용을 억제한다."""
    if len(frame_paths) <= limit:
        return frame_paths
    step = (len(frame_paths) - 1) / (limit - 1)
    return [frame_paths[round(i * step)] for i in range(limit)]


@dataclass
class Decision:
    text: str
    source: str  # "ocr" | "vlm"
    confidence: str


@dataclass
class OcrAttempt:
    frame: str
    text: str
    confidence: str
    matched_speech: bool  # True 면 이미 대사로 전달된 정보라 화면 전용으로 채택하지 않았다


@dataclass
class DescribeAttempt:
    text: str
    confidence: str
    max_chars: int
    rejected_reason: Optional[str] = None  # "too_long" | "low_confidence" | None(채택)


@dataclass
class NarrateTrace:
    ocr_attempts: List[OcrAttempt] = field(default_factory=list)
    describe_attempts: List[DescribeAttempt] = field(default_factory=list)
    skip_reason: Optional[str] = None  # decide() 가 None 을 반환할 때만 채워진다


def _scan_ocr(
    frame_paths: List[str], speech_texts: List[str], adapter: ModelAdapter
) -> Tuple[Optional[Decision], List[OcrAttempt]]:
    attempts: List[OcrAttempt] = []
    picked: Optional[Decision] = None
    for frame_path in frame_paths:
        result = adapter.read_text(frame_path)
        text = result.text.strip()
        matched_speech = bool(text) and any(
            _similar(text, s) >= config.OCR_MATCH_SIMILARITY_THRESHOLD for s in speech_texts
        )
        attempts.append(
            OcrAttempt(frame=frame_path, text=text, confidence=result.confidence, matched_speech=matched_speech)
        )
        if picked is None and text and not matched_speech:
            picked = Decision(text=text, source="ocr", confidence=result.confidence)
    return picked, attempts


def _scan_describe(
    frame_paths: List[str], context: Optional[str], max_chars: int, adapter: ModelAdapter
) -> Tuple[Optional[Decision], List[DescribeAttempt]]:
    attempts: List[DescribeAttempt] = []
    rounds = 1 + config.DESCRIBE_MAX_RETRIES
    for _ in range(rounds):
        result = adapter.describe(frame_paths, context, max_chars)
        text = result.text.strip()
        if not text:
            attempts.append(DescribeAttempt("", result.confidence, max_chars, "empty"))
            continue
        if len(text) > max_chars:
            attempts.append(DescribeAttempt(text, result.confidence, max_chars, "too_long"))
            continue
        if result.confidence != "high":
            attempts.append(DescribeAttempt(text, result.confidence, max_chars, "low_confidence"))
            continue
        attempts.append(DescribeAttempt(text, result.confidence, max_chars, None))
        return Decision(text=text, source="vlm", confidence=result.confidence), attempts
    return None, attempts


def decide(
    frame_paths: List[str],
    max_chars: int,
    speech_texts: List[str],
    context_before: Optional[str],
    prior_segment_texts: List[str],
    adapter: ModelAdapter,
) -> Tuple[Optional[Decision], NarrateTrace]:
    trace = NarrateTrace()

    if not frame_paths:
        trace.skip_reason = "no_frames"
        return None, trace

    ocr_candidates = _pick_frames(frame_paths, config.MAX_OCR_FRAMES_PER_GAP)
    picked, trace.ocr_attempts = _scan_ocr(ocr_candidates, speech_texts, adapter)

    if picked is None:
        describe_candidates = _pick_frames(frame_paths, config.MAX_DESCRIBE_FRAMES_PER_GAP)
        picked, trace.describe_attempts = _scan_describe(describe_candidates, context_before, max_chars, adapter)

    if picked is None:
        trace.skip_reason = "no_candidate"
        return None, trace

    if _is_duplicate(picked.text, prior_segment_texts, speech_texts):
        trace.skip_reason = "duplicate"
        return None, trace

    return picked, trace
