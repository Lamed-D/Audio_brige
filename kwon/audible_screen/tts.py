from __future__ import annotations

import shutil
from pathlib import Path

from .media import fit_wav_to_duration, wav_duration


def shorten_for_duration(text: str, actual: float, available: float) -> str:
    if actual <= 0 or available <= 0:
        return ""
    target = max(3, int(len(text) * available / actual * 0.88))
    if target >= len(text):
        return text
    shortened = text[:target]
    for separator in (". ", ", ", "고 ", "며 ", "서 ", "을 ", "를 "):
        split_at = shortened.rfind(separator)
        if split_at >= max(3, target // 2):
            shortened = shortened[: split_at + (1 if separator.startswith(".") else 0)]
            break
    shortened = shortened.rstrip(" ,.;:")
    if shortened and shortened[-1] not in ".!?다요":
        shortened += "."
    return shortened


class SpeechSynthesizer:
    def __init__(self, model: str, voice: str, max_speedup: float = 1.5) -> None:
        self.model = model
        self.voice = voice
        self.max_speedup = max(1.0, min(float(max_speedup), 2.0))

    def speak(self, text: str, output_path: Path) -> None:
        from openai import OpenAI

        parameters = {
            "model": self.model,
            "voice": self.voice,
            "input": text,
            "response_format": "wav",
        }
        if self.model.startswith("gpt-4o-mini-tts"):
            parameters["instructions"] = (
                "차분하고 명료한 한국어 화면해설로 말한다. "
                "평소보다 약 1.25배 빠르게, 문장 사이 멈춤 없이 읽는다."
            )

        with OpenAI().audio.speech.with_streaming_response.create(
            **parameters
        ) as response:
            response.stream_to_file(output_path)

    def fit_to_gap(
        self, text: str, available: float, output_path: Path
    ) -> tuple[str, float, Path] | None:
        """문장을 한 번 줄이고, 필요한 경우 피치를 보존해 속도를 맞춘다."""
        target_duration = max(0.4, available * 0.94)
        raw_path = output_path.with_name(f"{output_path.stem}_raw.wav")
        raw_path.unlink(missing_ok=True)
        output_path.unlink(missing_ok=True)

        try:
            self.speak(text, raw_path)
            actual = wav_duration(raw_path)
            if actual <= target_duration:
                shutil.move(str(raw_path), str(output_path))
                return text, actual, output_path
            if actual / target_duration <= self.max_speedup:
                fitted_duration = fit_wav_to_duration(
                    raw_path, output_path, target_duration
                )
                return text, fitted_duration, output_path

            shorter = shorten_for_duration(text, actual, target_duration)
            if not shorter or shorter == text:
                return None

            raw_path.unlink(missing_ok=True)
            self.speak(shorter, raw_path)
            actual = wav_duration(raw_path)
            if actual <= target_duration:
                shutil.move(str(raw_path), str(output_path))
                return shorter, actual, output_path
            if actual / target_duration <= self.max_speedup:
                fitted_duration = fit_wav_to_duration(
                    raw_path, output_path, target_duration
                )
                return shorter, fitted_duration, output_path
            return None
        finally:
            raw_path.unlink(missing_ok=True)
