import difflib
import re
from typing import List, Optional

import config
from adapters.base import ModelAdapter
from core.session import SessionState
from core.silence import Gap


def _normalize(text: str) -> str:
    return re.sub(r"[\s\.,!?~\-\"'·…]", "", text)


def _similar(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, _normalize(a), _normalize(b)).ratio()


def _is_duplicate(session: SessionState, text: str) -> bool:
    for entry in session.narration_history[-5:]:
        if _similar(text, entry["text"]) >= config.DUPLICATE_SIMILARITY_THRESHOLD:
            return True
    for entry in session.recent_speech[-5:]:
        if _similar(text, entry["text"]) >= config.DUPLICATE_SIMILARITY_THRESHOLD:
            return True
    return False


def _pick_frames(frame_paths: List[str], limit: int = 3) -> List[str]:
    if len(frame_paths) <= limit:
        return frame_paths
    step = (len(frame_paths) - 1) / (limit - 1)
    return [frame_paths[round(i * step)] for i in range(limit)]


def _try_ocr(session: SessionState, frame_paths: List[str], adapter: ModelAdapter) -> Optional[dict]:
    speech_texts = [s["text"] for s in session.recent_speech]
    for frame_path in frame_paths:
        result = adapter.read_text(frame_path)
        text = result.text.strip()
        if not text:
            continue
        if any(_similar(text, s) >= config.OCR_MATCH_SIMILARITY_THRESHOLD for s in speech_texts):
            continue  # 이미 대사로 전달된 정보
        return {"text": text, "confidence": result.confidence}
    return None


def _try_describe(session: SessionState, gap: Gap, frame_paths: List[str], adapter: ModelAdapter) -> Optional[dict]:
    context = session.context_before(gap.start)
    attempts = 1 + config.DESCRIBE_MAX_RETRIES
    for _ in range(attempts):
        result = adapter.describe(frame_paths, context, gap.max_chars)
        text = result.text.strip()
        if text and len(text) <= gap.max_chars and result.confidence == "high":
            return {"text": text, "confidence": result.confidence}
    return None


def _estimated_duration(text: str) -> float:
    """TTS 를 만들지 않는 text 모드에서, 자막 노출 시간과 향후 TTS 예상 길이를 위해 글자 수로 추정한다."""
    return round(len(text) / config.SPEECH_RATE_SYLLABLES_PER_SEC, 3)


def _synthesize(session: SessionState, gap: Gap, text: str, adapter: ModelAdapter) -> tuple:
    """tts 모드에서만 호출된다. (clip_path, duration) 을 반환한다."""
    clip_path = session.next_clip_path()
    clip = adapter.speak(text, clip_path, speed=1.0)
    if clip.duration > gap.dur and gap.dur > 0:
        needed_speed = min(max(clip.duration / gap.dur, config.TTS_MIN_SPEED), config.TTS_MAX_SPEED)
        if needed_speed > 1.0:
            clip = adapter.speak(text, clip_path, speed=needed_speed)
    return clip.path, clip.duration


def process_gap(session: SessionState, gap: Gap, adapter: ModelAdapter) -> Optional[dict]:
    frame_paths = session.frames_in(gap.start, gap.end)
    if not frame_paths:
        frame_paths = session.frames_in(gap.start - 1.0, gap.end + 1.0)
    if not frame_paths:
        return None
    frame_paths = _pick_frames(frame_paths)

    picked = _try_ocr(session, frame_paths, adapter)
    source = "ocr"
    if picked is None:
        picked = _try_describe(session, gap, frame_paths, adapter)
        source = "vlm"
    if picked is None:
        return None

    text, confidence = picked["text"], picked["confidence"]

    if _is_duplicate(session, text):
        return None
    if not session.density_ok_and_record(gap.start):
        return None

    if session.mode == "tts":
        clip_path, duration = _synthesize(session, gap, text, adapter)
    else:
        clip_path, duration = None, _estimated_duration(text)

    session.record_narration(gap.start, text)
    return session.enqueue_ready(gap, text, source, confidence, clip_path, duration)
