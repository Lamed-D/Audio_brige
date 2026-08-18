import pytest
from PIL import Image

from audible_screen.workflow import (
    narration_similarity,
    remove_adjacent_duplicates,
    sample_gap_times,
    sample_triplets_per_second,
    select_keyframes,
    select_gaps,
    split_gap_windows,
)


def test_three_frames_favor_completed_late_state():
    assert sample_gap_times(10.0, 20.0, 3) == [12.0, 16.0, 19.0]


def test_one_frame_uses_midpoint():
    assert sample_gap_times(4.0, 8.0, 1) == [6.0]


def test_invalid_gap_is_rejected():
    with pytest.raises(ValueError):
        sample_gap_times(5.0, 5.0, 3)


def test_gaps_are_selected_across_the_whole_timeline():
    gaps = [
        {"id": "a", "start": 1.0, "duration": 2.0},
        {"id": "b", "start": 8.0, "duration": 5.0},
        {"id": "c", "start": 4.0, "duration": 4.0},
    ]
    assert [item["id"] for item in select_gaps(gaps, 2)] == ["a", "c"]


def test_samples_start_middle_end_for_each_second():
    assert sample_triplets_per_second(10.0, 12.0) == [
        10.05,
        10.5,
        10.95,
        11.05,
        11.5,
        11.95,
    ]


def test_partial_seconds_are_also_sampled_three_times():
    assert sample_triplets_per_second(1.2, 1.8) == [1.23, 1.5, 1.77]


def test_long_gap_is_split_into_bounded_vision_windows():
    gap = {
        "id": "gap_001",
        "start": 2.0,
        "end": 11.0,
        "duration": 9.0,
        "max_chars": 40,
    }
    windows = split_gap_windows(gap, 4.0)
    assert [(item["start"], item["end"]) for item in windows] == [
        (2.0, 6.0),
        (6.0, 10.0),
        (10.0, 11.0),
    ]
    assert all(item["parent_gap_id"] == "gap_001" for item in windows)


def test_keyframes_keep_start_middle_end_and_large_change(tmp_path):
    paths = []
    colors = [0, 0, 0, 255, 255, 255, 255]
    for index, color in enumerate(colors):
        path = tmp_path / f"{index}.jpg"
        Image.new("L", (64, 36), color=color).save(path)
        paths.append(path)

    selected_paths, selected_times = select_keyframes(
        paths, [float(index) for index in range(7)], max_frames=4
    )
    assert paths[0] in selected_paths
    assert paths[3] in selected_paths
    assert paths[-1] in selected_paths
    assert len(selected_paths) == len(selected_times) == 4


def test_adjacent_similar_narration_is_removed():
    results = [
        {
            "id": "gap_000",
            "start": 1.0,
            "end": 3.0,
            "narration": "남성이 숟가락을 입으로 가져간다.",
        },
        {
            "id": "gap_001",
            "start": 4.0,
            "end": 6.0,
            "narration": "남성이 숟가락을 입에 가져간다.",
        },
    ]
    assert narration_similarity(results[0]["narration"], results[1]["narration"]) > 0.68
    remove_adjacent_duplicates(results)
    assert results[1]["source"] == "skip"
    assert results[1]["narration"] == ""
