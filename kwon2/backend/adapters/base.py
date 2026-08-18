from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import List, Optional


@dataclass
class Word:
    start: float
    end: float
    text: str


@dataclass
class SpeechSegment:
    start: float
    end: float
    text: str


@dataclass
class TranscribeResult:
    duration: float
    words: List[Word]
    segments: List[SpeechSegment]


@dataclass
class ReadTextResult:
    text: str
    confidence: str  # "high" | "low"


@dataclass
class DescribeResult:
    text: str
    confidence: str  # "high" | "low"
    importance: str = "normal"  # "normal" | "high"
    pause_eligible: bool = False
    should_narrate: bool = True
    source: str = "vlm"  # "ocr" | "vlm"
    reason: str = ""


@dataclass
class SpeechClip:
    path: str
    duration: float


class ModelAdapter(ABC):
    """4장 어댑터 계층. 제공자를 바꿀 때 이 인터페이스의 구현체만 교체한다."""

    @abstractmethod
    def transcribe(self, audio_path: str, language: str = "ko") -> TranscribeResult:
        ...

    @abstractmethod
    def read_text(self, image_path: str) -> ReadTextResult:
        ...

    @abstractmethod
    def describe(self, image_paths: List[str], context: Optional[str], max_chars: int) -> DescribeResult:
        ...

    @abstractmethod
    def speak(self, text: str, output_path: str, speed: float = 1.0) -> SpeechClip:
        ...
