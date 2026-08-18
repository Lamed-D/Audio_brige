from audible_screen.tts import shorten_for_duration


def test_long_tts_text_is_shortened_without_cutting_to_empty_text():
    shortened = shorten_for_duration(
        "남성이 숟가락으로 음식을 떠서 천천히 입으로 가져간다.",
        actual=6.0,
        available=3.0,
    )
    assert shortened
    assert len(shortened) < 30
