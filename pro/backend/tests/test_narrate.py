from adapters.base import DescribeResult, ReadTextResult
from pipeline.narrate import _scan_ocr, decide


class CompletingTextAdapter:
    def __init__(self):
        self.calls = []

    def read_text(self, image_path: str) -> ReadTextResult:
        self.calls.append(image_path)
        return ReadTextResult(
            text={"early.jpg": "보", "middle.jpg": "보고", "late.jpg": "보고서 완료"}[image_path],
            confidence="high",
        )


def test_ocr_prefers_latest_completed_text_and_stops_calling():
    adapter = CompletingTextAdapter()

    decision, attempts = _scan_ocr(
        ["early.jpg", "middle.jpg", "late.jpg"], [], adapter
    )

    assert decision is not None
    assert decision.text == "보고서 완료"
    assert adapter.calls == ["late.jpg"]
    assert [attempt.frame for attempt in attempts] == ["late.jpg"]


class MeaningAwareAdapter:
    def __init__(self, result: DescribeResult):
        self.result = result
        self.contexts = []

    def read_text(self, image_path: str):
        raise AssertionError("OCR 결과를 바로 해설로 쓰면 안 됩니다")

    def describe(self, image_paths, context, max_chars: int) -> DescribeResult:
        self.contexts.append(context)
        return self.result


def test_decide_skips_platform_logo_without_calling_standalone_ocr():
    adapter = MeaningAwareAdapter(
        DescribeResult(
            text="",
            confidence="high",
            should_narrate=False,
            reason="플랫폼 로고만 반복 표시됨",
        )
    )

    decision, trace = decide(
        ["gap_000_gap_t000001000_00000.jpg"],
        30,
        [],
        '{"recurring_branding":["Netflix"]}',
        [],
        adapter,
    )

    assert decision is None
    assert trace.skip_reason == "not_meaningful:플랫폼 로고만 반복 표시됨"


def test_decide_uses_verified_person_name_from_contextual_description():
    adapter = MeaningAwareAdapter(
        DescribeResult(
            text="나폴리 맛피아가 냉장고 앞에 앉아 있다",
            confidence="high",
            importance="high",
            pause_eligible=True,
            should_narrate=True,
            source="vlm",
        )
    )

    decision, trace = decide(
        ["gap_000_before_t000001000_00000.jpg", "gap_000_gap_t000002000_00001.jpg"],
        40,
        ["오늘의 참가자를 소개합니다"],
        '{"people":[{"name":"나폴리 맛피아","evidence_time_ms":500}]}',
        [],
        adapter,
    )

    assert trace.skip_reason is None
    assert decision is not None
    assert decision.text == "나폴리 맛피아가 냉장고 앞에 앉아 있다"
    assert decision.importance == "high"
    assert decision.pause_eligible is True
