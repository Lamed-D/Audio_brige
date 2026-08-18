import pytest

from audible_screen.input_source import validate_video_url


def test_accepts_public_http_urls():
    assert validate_video_url("https://example.com/video.mp4") == "https://example.com/video.mp4"


@pytest.mark.parametrize(
    "url",
    [
        "file:///C:/video.mp4",
        "http://localhost/video.mp4",
        "http://127.0.0.1/video.mp4",
        "not-a-url",
    ],
)
def test_rejects_unsafe_or_invalid_urls(url):
    with pytest.raises(ValueError):
        validate_video_url(url)

