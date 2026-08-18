from audible_screen.subtitles import (
    accessible_subtitle_entries,
    format_srt_timestamp,
    render_srt,
)


def test_srt_timestamp_format():
    assert format_srt_timestamp(3661.234) == "01:01:01,234"


def test_accessible_srt_combines_dialogue_and_audio_description():
    transcript = [{"start": 0.0, "end": 1.0, "text": "안녕하세요."}]
    narration = [{"start": 1.5, "end": 3.0, "narration": "화면에 제목이 나타난다."}]
    entries = accessible_subtitle_entries(transcript, narration)
    rendered = render_srt(entries)
    assert "안녕하세요." in rendered
    assert "[화면해설] 화면에 제목이 나타난다." in rendered
    assert "00:00:01,500 --> 00:00:03,000" in rendered
