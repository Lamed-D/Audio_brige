import base64
import json
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
    "너는 시각장애인을 위한 화면해설 작가다. 다음 규칙을 반드시 지켜라.\n"
    "- 보이는 것만 서술한다. 인물의 의도나 감정을 추측하지 않는다\n"
    "- 현재형으로 짧게 쓴다\n"
    "- 함께 주어지는 '최근 대사'를 먼저 읽고, 그 내용으로 이미 전달된 정보는 다시 서술하지 않는다\n"
    "- 최근 대사만으로 이미 충분히 설명되는 장면이면 새로 서술하지 말고 confidence 를 low 로 표시한다\n"
    "- 인물의 외형, 연령, 인종 등을 임의로 단정하지 않는다\n"
    "- 반드시 지정된 최대 글자 수 이내로 작성한다\n"
    '- 결과는 {"text": "...", "confidence": "high"|"low"} 형식의 JSON 하나만 출력한다\n'
    "- 장면을 확신 있게 서술할 수 없으면 confidence 를 low 로 표시한다"
)


def _encode_image(image_path: str) -> str:
    with open(image_path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")


class OpenAIAdapter(ModelAdapter):
    def __init__(self):
        if not config.OPENAI_API_KEY:
            raise RuntimeError("OPENAI_API_KEY 환경 변수가 설정되지 않았습니다.")
        self.client = OpenAI(api_key=config.OPENAI_API_KEY)

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
        resp = self.client.chat.completions.create(
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
                        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
                    ],
                },
            ],
            temperature=0,
        )
        text = (resp.choices[0].message.content or "").strip()
        confidence = "high" if len(text) >= 2 else "low"
        return ReadTextResult(text=text, confidence=confidence)

    def describe(self, image_paths: List[str], context: Optional[str], max_chars: int) -> DescribeResult:
        content = [
            {
                "type": "text",
                "text": f"최대 {max_chars}자 이내로 이 장면을 서술해줘."
                        + (f" 최근 대사(시간순): {context}" if context else " 최근 대사 없음(구간 시작부)."),
            }
        ]
        for p in image_paths:
            b64 = _encode_image(p)
            content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}})

        resp = self.client.chat.completions.create(
            model=config.OPENAI_VISION_MODEL,
            messages=[
                {"role": "system", "content": DESCRIBE_SYSTEM_PROMPT},
                {"role": "user", "content": content},
            ],
            response_format={"type": "json_object"},
            temperature=0.4,
        )
        raw = resp.choices[0].message.content or "{}"
        try:
            data = json.loads(raw)
            text = str(data.get("text", "")).strip()
            confidence = data.get("confidence", "low")
        except json.JSONDecodeError:
            text, confidence = "", "low"
        return DescribeResult(text=text, confidence=confidence)

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
