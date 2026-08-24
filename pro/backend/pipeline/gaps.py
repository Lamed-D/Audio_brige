"""M2: 배치 모드 무음 구간(gap) 산출.

core.silence.GapDetector 는 실시간 스트리밍(구형 /session 캡처)을 위한 상태
머신이다. 이 사전 처리 파이프라인은 영상 전체 오디오를 한 번에 받으므로,
단어 타임스탬프 전체를 미리 보고 훨씬 단순하게 계산할 수 있다. 두 구현은
"짧은 발화로 갈라진 gap 병합" 규칙(연동규격 6.1)을 공유하지만 서로 대체하지
않는다.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Tuple

import config
from adapters.base import TranscribeResult


@dataclass
class Gap:
    start_ms: int
    end_ms: int
    max_chars: int


def _speech_spans_ms(result: TranscribeResult) -> List[Tuple[int, int]]:
    if result.words:
        return [(round(w.start * 1000), round(w.end * 1000)) for w in result.words]
    return [(round(s.start * 1000), round(s.end * 1000)) for s in result.segments]


def _raw_silence_intervals(spans: List[Tuple[int, int]], duration_ms: int) -> List[list]:
    raw = []
    prev_end = 0
    for start, end in spans:
        if start > prev_end:
            raw.append([prev_end, start])
        prev_end = max(prev_end, end)
    if duration_ms > prev_end:
        raw.append([prev_end, duration_ms])
    return raw


def _merge_short_speech_gaps(raw_gaps: List[list]) -> List[list]:
    if not raw_gaps:
        return []
    min_merge_ms = round(config.MIN_MERGE_SPEECH_SEC * 1000)
    merged = [list(raw_gaps[0])]
    for gap in raw_gaps[1:]:
        last = merged[-1]
        speech_between = gap[0] - last[1]
        if speech_between < min_merge_ms:
            last[1] = gap[1]
        else:
            merged.append(list(gap))
    return merged


def build_gaps(result: TranscribeResult, duration_ms: int) -> List[Gap]:
    spans = _speech_spans_ms(result)
    raw_gaps = _raw_silence_intervals(spans, duration_ms)
    merged_gaps = _merge_short_speech_gaps(raw_gaps)

    min_gap_ms = round(config.MIN_GAP_DURATION_SEC * 1000)
    margin_ms = round(config.GAP_MARGIN_SEC * 1000)

    gaps: List[Gap] = []
    for start, end in merged_gaps:
        if end - start < min_gap_ms:
            continue
        eff_start = start + margin_ms
        eff_end = end - margin_ms
        if eff_end <= eff_start:
            continue
        dur_sec = (eff_end - eff_start) / 1000
        max_chars = round(dur_sec * config.SPEECH_RATE_SYLLABLES_PER_SEC)
        if max_chars <= 0:
            continue
        gaps.append(Gap(eff_start, eff_end, max_chars))

    return _apply_density_cap(gaps)


def _apply_density_cap(gaps: List[Gap]) -> List[Gap]:
    from collections import deque

    window_ms = config.DENSITY_WINDOW_SEC * 1000
    kept: List[Gap] = []
    recent = deque()
    for gap in gaps:
        while recent and gap.start_ms - recent[0] > window_ms:
            recent.popleft()
        if len(recent) >= config.MAX_GAPS_PER_WINDOW:
            continue
        recent.append(gap.start_ms)
        kept.append(gap)
    return kept
