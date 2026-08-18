from __future__ import annotations

import base64
import json
import re
from difflib import SequenceMatcher
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field


class SceneAnalysis(BaseModel):
    frame_texts: list[str] = Field(
        description="각 프레임에서 실제로 읽힌 글자. 글자가 없거나 불완전하면 빈 문자열"
    )
    stable_text: str = Field(description="시간순 프레임 비교 후 완성됐다고 확인한 화면 글자")
    new_screen_text: str = Field(description="음성 자막에는 없고 화면에서만 새로 전달된 핵심 글자")
    resolved_reference: str = Field(description="이것, 이렇게, 아까 같은 표현을 화면으로 확인한 결과")
    scene_description: str = Field(description="글자가 없을 때 사용할 짧은 장면 설명")
    narration: str = Field(description="나중에 TTS로 읽을 최종 후보 문장")
    source: Literal["ocr", "vlm", "skip"]
    confidence: Literal["high", "medium", "low"]
    reason: str = Field(description="판단 근거를 한 문장으로 설명")


def clean_line(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().strip('"\'')


def encode_image(path: Path) -> str:
    encoded = base64.b64encode(path.read_bytes()).decode("utf-8")
    return f"data:image/jpeg;base64,{encoded}"


SYSTEM_PROMPT = """너는 영상의 대사 사이 빈 구간을 채우는 접근성 음성해설 제작가이다.
시각장애인이 소리만 들어도 화면의 핵심 정보를 이해하도록 돕는다.
화면에 확실히 보이는 사실만 사용하며 감정, 의도, 관계, 보이지 않는 글자를 추측하지 않는다.
입력 이미지는 같은 무발화 구간에서 장면 변화와 완성 시점을 고려해 뽑은 시간순 프레임들이다.
음성 자막으로 이미 전달된 정보는 화면해설에서 반복하지 않는다."""


def build_prompt(
    gap_start: float,
    gap_end: float,
    max_chars: int,
    caption_context: list[dict],
    previous_narration: str,
) -> str:
    captions_json = json.dumps(caption_context, ensure_ascii=False, indent=2)
    return f"""다음 시간순 프레임들을 비교해 이 구간의 화면해설 후보를 작성하라.

구간: {gap_start:.2f}초 ~ {gap_end:.2f}초
권장 narration 길이: 최대 {max_chars}자
주변 음성 자막(JSON, before/overlap/after 관계 포함):
{captions_json if caption_context else '(없음)'}
직전 화면해설: {previous_narration or '(없음)'}

[1단계: 음성 자막 문맥 확인]
1. 앞뒤 자막을 읽고 현재 무발화 구간이 어떤 대화 사이에 있는지 파악한다.
2. 자막의 '이것', '이렇게', '저기', '아까' 같은 표현은 이미지에서 대상이나 앞 장면을 확실히 확인할 수 있을 때만 resolved_reference에 적는다.
3. 이미지로 확인되지 않는 지시 대상은 추측하지 않는다.

[2단계: 화면 글자 판정]
4. frame_texts에는 각 프레임에서 실제로 읽힌 글자만 프레임 수와 같은 개수로 적는다. 행동이나 장면 설명을 절대 넣지 않는다.
5. 각 프레임의 OCR 결과를 단순히 합치지 말고 시간 변화로 비교한다.
6. 글자가 점진적으로 나타나면 뒤쪽 두 프레임 이상에서 확인된 완성 문구만 stable_text로 쓴다.
7. 마지막에도 잘렸거나 흐리면 추측하지 말고 stable_text를 빈 문자열로 둔다.
8. stable_text 중 주변 음성 자막에서 이미 말했거나 같은 뜻으로 전달된 부분은 제외하고, 화면에서만 새로 알 수 있는 핵심 글자만 new_screen_text로 쓴다.
9. 워터마크, 로고, 반복 영상 자막은 제외한다.

[3단계: 최종 해설]
10. new_screen_text가 있으면 이를 가장 먼저 전달하고 source를 ocr로 정한다.
11. 새 화면 글자가 없으면 지시어 이해에 필요한 대상, 중요한 행동·장소·화면 변화만 scene_description으로 쓰고 source를 vlm으로 정한다.
12. 음성 자막이나 직전 해설과 중복되거나 없어도 이해에 지장이 없으면 source는 skip, narration은 빈 문자열로 둔다.
13. narration은 현재형 한 문장, 최대 {max_chars}자에 가깝게 짧게 쓴다. '화면에는' 같은 군더더기를 피한다.
14. confidence=high는 여러 프레임에서 동일하게 확인되는 사실에만 사용한다. 애매하면 설명을 만들지 말고 skip한다.

반드시 구조화된 필드를 모두 채워 반환하라."""


class SceneAnalyzer:
    def __init__(self, vision_model: str, fallback_model: str = "") -> None:
        from openai import OpenAI

        self.vision_model = vision_model
        self.fallback_model = fallback_model.strip()
        self.client = OpenAI()

    def analyze(
        self,
        frame_paths: list[Path],
        frame_times: list[float],
        gap: dict,
        caption_context: list[dict] | None = None,
        previous_narration: str = "",
        model: str | None = None,
    ) -> dict:
        if len(frame_paths) != len(frame_times) or not frame_paths:
            raise ValueError("프레임 경로와 시각은 같은 개수로 한 개 이상 필요합니다.")

        content: list[dict] = [
            {
                "type": "input_text",
                "text": build_prompt(
                    gap_start=float(gap["start"]),
                    gap_end=float(gap["end"]),
                    max_chars=int(gap["max_chars"]),
                    caption_context=caption_context or [],
                    previous_narration=previous_narration,
                ),
            }
        ]
        for index, (path, timestamp) in enumerate(zip(frame_paths, frame_times), start=1):
            content.append(
                {
                    "type": "input_text",
                    "text": f"프레임 {index}/{len(frame_paths)} - 영상 {timestamp:.2f}초",
                }
            )
            content.append(
                {
                    "type": "input_image",
                    "image_url": encode_image(path),
                    "detail": "high",
                }
            )

        response = self.client.responses.parse(
            model=model or self.vision_model,
            input=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": content},
            ],
            text_format=SceneAnalysis,
        )
        parsed = response.output_parsed
        if parsed is None:
            raise RuntimeError("OpenAI 응답을 SceneAnalysis 형식으로 해석하지 못했습니다.")

        result = parsed.model_dump()
        result["frame_texts"] = [clean_line(text) for text in result["frame_texts"]]
        for key in (
            "stable_text",
            "new_screen_text",
            "resolved_reference",
            "scene_description",
            "narration",
            "reason",
        ):
            result[key] = clean_line(result[key])

        return validate_analysis(result, len(frame_paths), int(gap["max_chars"]))

    def analyze_with_fallback(
        self,
        frame_paths: list[Path],
        frame_times: list[float],
        gap: dict,
        caption_context: list[dict] | None = None,
    ) -> dict:
        context = caption_context or []
        primary = self.analyze(frame_paths, frame_times, gap, context)
        primary["model_used"] = self.vision_model
        if not self.fallback_model or self.fallback_model == self.vision_model:
            return primary
        if not needs_fallback(primary, context):
            return primary

        try:
            fallback = self.analyze(
                frame_paths,
                frame_times,
                gap,
                context,
                model=self.fallback_model,
            )
            fallback["model_used"] = self.fallback_model
            fallback["fallback_used"] = True
            if fallback["source"] != "skip":
                return fallback
        except Exception as exc:
            primary["fallback_error"] = str(exc)
        primary["fallback_used"] = True
        return primary


def normalize_text(text: str) -> str:
    return re.sub(r"[^0-9a-zA-Z가-힣]", "", text).lower()


def text_similarity(left: str, right: str) -> float:
    a = normalize_text(left)
    b = normalize_text(right)
    if not a or not b:
        return 0.0
    if a in b or b in a:
        return min(len(a), len(b)) / max(len(a), len(b))
    return SequenceMatcher(None, a, b).ratio()


def validate_analysis(result: dict, frame_count: int, max_chars: int) -> dict:
    """모델의 자기 확신과 별개로 OCR 근거와 출력 구조를 검증한다."""
    frame_texts = list(result.get("frame_texts") or [])[:frame_count]
    frame_texts.extend([""] * (frame_count - len(frame_texts)))
    result["frame_texts"] = frame_texts
    result.setdefault("validation", "passed")

    if result.get("source") == "ocr":
        stable = str(result.get("stable_text", ""))
        new_text = str(result.get("new_screen_text", ""))
        confirmations = sum(
            text_similarity(stable, observed) >= 0.72
            for observed in frame_texts
            if observed
        )
        derived = text_similarity(stable, new_text) >= 0.45
        if not stable or not new_text or confirmations < 2 or not derived:
            result.update(
                source="skip",
                narration="",
                confidence="low",
                validation="rejected_unstable_ocr",
            )
    elif result.get("source") == "vlm":
        if not result.get("scene_description") or result.get("confidence") != "high":
            result.update(
                source="skip",
                narration="",
                confidence="low",
                validation="rejected_uncertain_scene",
            )
    else:
        result.update(source="skip", narration="")

    narration = clean_line(str(result.get("narration", "")))
    if narration and len(narration) > max_chars * 1.35:
        result["validation"] = "narration_needs_tts_fit"
    result["narration"] = narration
    return result


DEICTIC_WORDS = ("이거", "이것", "이렇게", "저기", "저것", "아까", "여기")


def needs_fallback(result: dict, caption_context: list[dict]) -> bool:
    if result.get("source") == "skip" or result.get("confidence") != "high":
        return True
    captions = " ".join(str(item.get("text", "")) for item in caption_context)
    return any(word in captions for word in DEICTIC_WORDS)
