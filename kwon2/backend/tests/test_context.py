import json

from adapters.base import SpeechSegment
from pipeline.build_manifest import _dialogue_context
from pipeline.gaps import Gap


def test_dialogue_context_contains_before_after_and_verified_people():
    speech = [
        SpeechSegment(0.0, 1.0, "나폴리 맛피아를 소개합니다"),
        SpeechSegment(1.2, 2.0, "냉장고를 확인해 보죠"),
        SpeechSegment(5.0, 6.0, "이제 요리를 시작합니다"),
    ]
    gap = Gap(start_ms=2200, end_ms=4800, max_chars=12)
    program_context = {
        "people": [
            {
                "name": "나폴리 맛피아",
                "aliases": ["권성준"],
                "evidence_time_ms": 500,
            }
        ]
    }

    context = json.loads(
        _dialogue_context(speech, gap, program_context, ["그가 냉장고로 향한다"])
    )

    assert [item["text"] for item in context["dialogue_before"]] == [
        "나폴리 맛피아를 소개합니다",
        "냉장고를 확인해 보죠",
    ]
    assert [item["text"] for item in context["dialogue_after_reference_only"]] == [
        "이제 요리를 시작합니다"
    ]
    assert context["program_context"]["people"][0]["name"] == "나폴리 맛피아"
    assert context["prior_narrations"] == ["그가 냉장고로 향한다"]
