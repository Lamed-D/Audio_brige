import base64
import json
import re
from pathlib import Path
from typing import List, Optional

import soundfile as sf
from openai import OpenAI

import config
from adapters.base import (
    DescribeResult,
    ModelAdapter,
    ReadTextResult,
    SpeechClip,
    SpeechSegment,
    TranscribeResult,
    Word,
)

DESCRIBE_SYSTEM_PROMPT = (
    "너는 시각장애인을 위한 상업용 화면해설의 수석 작가다. 이미지들은 시간순이며 "
    "before는 무음 직전, gap은 해설 후보 구간, after는 직후 장면이다.\n"
    "목표는 보이는 것을 전부 나열하는 것이 아니라, 대사만 들으면 놓치는 의미 있는 정보를 전달하는 것이다.\n"
    "우선순위:\n"
    "1. 인물의 정체가 프로그램 맥락·화면 명찰·자막으로 근거가 있으면 '요리사' 대신 실제 이름이나 검증된 별칭을 쓴다.\n"
    "2. 누가 무엇을 하는지, 중요한 반응·행동·장면 전환·공간 관계를 우선한다.\n"
    "3. 화면 글자는 대사에 없고 이해에 필요한 이름·점수·규칙·시간·장소일 때만 자연스러운 문장에 통합한다.\n"
    "4. 넷플릭스 같은 플랫폼 로고, 제작사 로고, 워터마크, 반복 프로그램 로고, 장식 자막만 보이면 해설하지 않는다.\n"
    "5. 정보가 많으면 전부 읽지 말고 핵심 1~3개를 인과관계가 드러나는 한두 문장으로 압축한다.\n"
    "6. 직후 대사는 현재 장면을 판별하는 참고용일 뿐, 아직 일어나지 않은 사건을 미리 말하거나 스포일러하지 않는다.\n"
    "7. 프로그램 맥락의 이름은 evidence_time_ms가 현재 시점 이하이거나 현재 프레임에서 직접 확인될 때만 사용한다.\n"
    "8. 이미 대사나 앞선 화면해설로 전달된 내용, 불확실한 추측, 감정·의도 단정은 제외한다.\n"
    "9. 해설할 가치가 없으면 should_narrate=false와 빈 text를 반환한다. confidence=low인 내용도 재생하지 않는다.\n"
    "10. 자연 무음보다 길더라도 반드시 필요한 복합 정보면 importance=high, pause_eligible=true로 표시한다.\n"
    "JSON만 출력한다: "
    '{"should_narrate":true|false,"text":"...","confidence":"high"|"low",'
    '"importance":"normal"|"high","pause_eligible":true|false,'
    '"source":"ocr"|"vlm","reason":"선택 또는 생략 이유"}'
)

PROGRAM_CONTEXT_PROMPT = (
    "영상 전체 자막과 시간순 대표 프레임을 보고 후속 화면해설에서 사용할 사실 사전을 만든다. "
    "외부 지식으로 이름을 추측하지 말고 자막·명찰·호명 등 근거가 있는 정보만 기록한다. "
    "각 사람의 name, aliases, role, visual_cues, evidence_time_ms를 정리하고, 장소·프로그램 규칙·반복 로고도 구분한다. "
    "플랫폼/제작사/워터마크처럼 해설할 필요가 없는 반복 표시는 recurring_branding에 넣는다. "
    "JSON만 출력한다: "
    '{"summary":"","people":[{"name":"","aliases":[],"role":"","visual_cues":"",'
    '"evidence_time_ms":0}],"locations":[],"important_terms":[],"recurring_branding":[]}'
)


def _encode_image(image_path: str) -> str:
    with open(image_path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")


def _frame_label(image_path: str, index: int) -> str:
    name = Path(image_path).name
    match = re.search(r"_(before|gap|after)_t(\d+)_", name)
    if match:
        return f"프레임 {index + 1}: {match.group(1)}, {int(match.group(2))}ms"
    match = re.search(r"overview_t(\d+)_", name)
    if match:
        return f"대표 프레임 {index + 1}: {int(match.group(1))}ms"
    return f"프레임 {index + 1}: 시간순"


class OpenAIAdapter(ModelAdapter):
    def __init__(self):
        if not config.OPENAI_API_KEY:
            raise RuntimeError("OPENAI_API_KEY 환경 변수가 설정되지 않았습니다.")
        self.client = OpenAI(api_key=config.OPENAI_API_KEY)

    def _json_completion(self, system_prompt: str, content):
        kwargs = {
            "model": config.OPENAI_VISION_MODEL,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": content},
            ],
            "response_format": {"type": "json_object"},
        }
        if config.OPENAI_VISION_MODEL.startswith("gpt-5"):
            kwargs["reasoning_effort"] = config.OPENAI_REASONING_EFFORT
        response = self.client.chat.completions.create(**kwargs)
        raw = response.choices[0].message.content or "{}"
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {}

    def analyze_program(self, transcript: str, image_paths: List[str]) -> dict:
        content = [
            {
                "type": "text",
                "text": "다음은 [시작ms-끝ms] 형식의 영상 전체 음성 자막이다.\n" + transcript,
            }
        ]
        for index, path in enumerate(image_paths):
            content.append({"type": "text", "text": _frame_label(path, index)})
            content.append(
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:image/jpeg;base64,{_encode_image(path)}",
                        "detail": config.OPENAI_VLM_IMAGE_DETAIL,
                    },
                }
            )
        data = self._json_completion(PROGRAM_CONTEXT_PROMPT, content)
        return data if isinstance(data, dict) else {}

    def transcribe(self, audio_path: str, language: str = "ko") -> TranscribeResult:
        with open(audio_path, "rb") as f:
            resp = self.client.audio.transcriptions.create(
                model=config.OPENAI_TRANSCRIBE_MODEL,
                file=f,
                language=language,
                response_format="verbose_json",
                timestamp_granularities=["word", "segment"],
            )
        words = [Word(w.start, w.end, w.word) for w in (resp.words or [])]
        segments = [SpeechSegment(s.start, s.end, s.text.strip()) for s in (resp.segments or [])]
        duration = float(getattr(resp, "duration", 0.0) or (segments[-1].end if segments else 0.0))
        return TranscribeResult(duration=duration, words=words, segments=segments)

    def read_text(self, image_path: str) -> ReadTextResult:
        b64 = _encode_image(image_path)
        kwargs = dict(
            model=config.OPENAI_VISION_MODEL,
            messages=[
                {
                    "role": "system",
                    "content": "이미지에 실제로 표시된 텍스트만 정확히 그대로 출력해. "
                                "텍스트가 없으면 빈 문자열만 출력해. 설명하거나 요약하지 마.",
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/jpeg;base64,{b64}",
                                "detail": config.OPENAI_OCR_IMAGE_DETAIL,
                            },
                        },
                    ],
                },
            ],
        )
        if config.OPENAI_VISION_MODEL.startswith("gpt-5"):
            kwargs["reasoning_effort"] = config.OPENAI_REASONING_EFFORT
        resp = self.client.chat.completions.create(**kwargs)
        text = (resp.choices[0].message.content or "").strip()
        confidence = "high" if len(text) >= 2 else "low"
        return ReadTextResult(text=text, confidence=confidence)

    def describe(self, image_paths: List[str], context: Optional[str], max_chars: int) -> DescribeResult:
        content = [
            {
                "type": "text",
                "text": (
                    f"최종 TTS 문장은 공백 포함 최대 {max_chars}자다. 아래 문맥 JSON을 먼저 읽고 "
                    "이미 알려진 정보와 직후 대사를 구분한 뒤 해설 여부를 결정하라.\n"
                    + (context or "{}")
                ),
            }
        ]
        for index, p in enumerate(image_paths):
            content.append({"type": "text", "text": _frame_label(p, index)})
            b64 = _encode_image(p)
            content.append(
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:image/jpeg;base64,{b64}",
                        "detail": config.OPENAI_VLM_IMAGE_DETAIL,
                    },
                }
            )

        data = self._json_completion(DESCRIBE_SYSTEM_PROMPT, content)
        text = str(data.get("text", "")).strip()
        confidence = data.get("confidence", "low")
        importance = data.get("importance", "normal")
        pause_eligible = data.get("pause_eligible", False) is True
        should_narrate = data.get("should_narrate", bool(text)) is True
        source = data.get("source", "vlm")
        reason = str(data.get("reason", "")).strip()
        if importance not in {"normal", "high"}:
            importance = "normal"
        if source not in {"ocr", "vlm"}:
            source = "vlm"
        return DescribeResult(
            text=text,
            confidence=confidence,
            importance=importance,
            pause_eligible=pause_eligible,
            should_narrate=should_narrate,
            source=source,
            reason=reason,
        )

    def speak(self, text: str, output_path: str, speed: float = 1.0) -> SpeechClip:
        with self.client.audio.speech.with_streaming_response.create(
            model=config.OPENAI_TTS_MODEL,
            voice=config.OPENAI_TTS_VOICE,
            input=text,
            speed=speed,
            response_format="wav",
        ) as resp:
            resp.stream_to_file(output_path)
        duration = sf.info(output_path).duration
        return SpeechClip(path=output_path, duration=duration)
