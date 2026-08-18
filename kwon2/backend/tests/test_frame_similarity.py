from pathlib import Path

import cv2
import numpy as np

from pipeline.media import _read_image, _write_jpeg, filter_similar_frames, frame_similarity


def _write_frame(path: Path, image: np.ndarray) -> str:
    assert cv2.imwrite(str(path), image)
    return str(path)


def test_identical_run_keeps_the_latest_frame(tmp_path: Path):
    image = np.full((180, 320, 3), 220, dtype=np.uint8)
    first = _write_frame(tmp_path / "first.jpg", image)
    middle = _write_frame(tmp_path / "middle.jpg", image)
    last = _write_frame(tmp_path / "last.jpg", image)

    selected, decisions = filter_similar_frames([first, middle, last], threshold=0.985)

    assert selected == [last]
    assert [item["action"] for item in decisions] == [
        "keep",
        "replace_similar",
        "replace_similar",
    ]


def test_visible_text_change_is_not_removed(tmp_path: Path):
    blank = np.full((180, 320, 3), 255, dtype=np.uint8)
    with_text = blank.copy()
    cv2.putText(
        with_text,
        "VOICE BRIDGE",
        (20, 100),
        cv2.FONT_HERSHEY_SIMPLEX,
        1,
        (0, 0, 0),
        2,
        cv2.LINE_AA,
    )
    blank_path = _write_frame(tmp_path / "blank.jpg", blank)
    text_path = _write_frame(tmp_path / "text.jpg", with_text)

    assert frame_similarity(blank_path, text_path) < 0.985
    selected, _ = filter_similar_frames([blank_path, text_path], threshold=0.985)
    assert selected == [blank_path, text_path]


def test_unicode_windows_path_can_be_written_and_read(tmp_path: Path):
    unicode_dir = tmp_path / "한글 폴더"
    unicode_dir.mkdir()
    path = unicode_dir / "프레임.jpg"
    image = np.full((90, 160, 3), 127, dtype=np.uint8)

    _write_jpeg(str(path), image)
    decoded = _read_image(str(path))

    assert path.is_file()
    assert decoded.shape == (90, 160)
