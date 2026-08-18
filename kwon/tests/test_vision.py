from audible_screen.vision import needs_fallback, validate_analysis


def base_result(**overrides):
    result = {
        "frame_texts": ["3분 뒤 완성", "3분 뒤 완성", "3분 뒤 완성"],
        "stable_text": "3분 뒤 완성",
        "new_screen_text": "3분 뒤 완성",
        "resolved_reference": "",
        "scene_description": "",
        "narration": "3분 뒤 완성.",
        "source": "ocr",
        "confidence": "high",
        "reason": "두 프레임 이상에서 확인",
    }
    result.update(overrides)
    return result


def test_stable_ocr_requires_two_matching_frames():
    result = validate_analysis(
        base_result(frame_texts=["", "틀린 글자", "3분 뒤 완성"]), 3, 20
    )
    assert result["source"] == "skip"
    assert result["validation"] == "rejected_unstable_ocr"


def test_action_cannot_be_invented_as_screen_text():
    result = validate_analysis(
        base_result(
            stable_text="메뉴",
            new_screen_text="숟가락을 입으로 가져간다",
            frame_texts=["메뉴", "메뉴", "메뉴"],
        ),
        3,
        20,
    )
    assert result["source"] == "skip"


def test_uncertain_vlm_is_skipped_and_escalated():
    result = validate_analysis(
        base_result(
            frame_texts=["", "", ""],
            stable_text="",
            new_screen_text="",
            scene_description="사람이 무언가를 든다",
            narration="사람이 무언가를 든다.",
            source="vlm",
            confidence="medium",
        ),
        3,
        20,
    )
    assert result["source"] == "skip"
    assert needs_fallback(result, [])
