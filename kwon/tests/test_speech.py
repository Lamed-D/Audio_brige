from audible_screen.speech import (
    Interval,
    OpenAISpeechDetector,
    find_non_speech_gaps,
    merge_intervals,
)


def test_merge_close_speech_intervals():
    result = merge_intervals([Interval(1.0, 2.0), Interval(2.2, 3.0), Interval(7.0, 8.0)])
    assert result == [Interval(1.0, 3.0), Interval(7.0, 8.0)]


def test_find_gaps_includes_video_edges_and_margin():
    result = find_non_speech_gaps(
        [Interval(3.0, 5.0), Interval(9.0, 10.0)],
        total_duration=14.0,
        min_gap=2.0,
        safety_margin=0.5,
        chars_per_second=4.0,
    )
    assert result == [
        {"id": "gap_000", "start": 0.5, "end": 2.5, "duration": 2.0, "max_chars": 8},
        {"id": "gap_001", "start": 5.5, "end": 8.5, "duration": 3.0, "max_chars": 12},
        {"id": "gap_002", "start": 10.5, "end": 13.5, "duration": 3.0, "max_chars": 12},
    ]


def test_openai_detector_processes_long_audio_in_parallel_chunks(tmp_path, monkeypatch):
    audio_path = tmp_path / "speech.mp3"
    audio_path.write_bytes(b"fake")
    monkeypatch.setattr("audible_screen.speech.probe_duration", lambda _: 250.0)

    def fake_extract(_source, _start, _duration, output):
        output.write_bytes(b"chunk")

    monkeypatch.setattr("audible_screen.speech.extract_audio_chunk", fake_extract)
    detector = OpenAISpeechDetector(chunk_seconds=120, max_workers=3)
    monkeypatch.setattr(
        detector,
        "_transcribe_chunk",
        lambda _path, offset: [
            {"start": offset, "end": offset + 1.0, "text": f"chunk {offset:g}"}
        ],
    )

    speech, transcript = detector.detect(str(audio_path))
    assert [item["start"] for item in transcript] == [0.0, 120.0, 240.0]
    assert speech == [
        Interval(0.0, 1.0),
        Interval(120.0, 121.0),
        Interval(240.0, 241.0),
    ]
