from dataclasses import dataclass
from typing import List, Optional

import config


@dataclass
class Gap:
    start: float
    end: float
    dur: float
    max_chars: int


class GapDetector:
    """실시간으로 들어오는 (t, db) 창을 순서대로 받아 6.1 규칙에 따라 무음 구간을 확정한다.

    - 두 무음 구간 사이 발화가 MIN_MERGE_SPEECH_SEC 미만이면 하나로 합친다
    - 확정은 그 발화가 MIN_MERGE_SPEECH_SEC 만큼 이어진 뒤에야 이루어진다 (병합 여부를 알아야 하므로)
    - MIN_GAP_DURATION_SEC 미만이거나 margin 을 적용한 뒤 길이가 0 이하이면 버린다
    - 무음이 MAX_GAP_WAIT_SEC 넘게 계속되면, 너무 오래 기다리지 않도록 그 시점에서 한 번 끊어 확정한다
    """

    def __init__(self):
        self.mode = "speech"
        self.cur_silence_start: Optional[float] = None
        self.pending_gap: Optional[List[float]] = None
        self.speech_resumed_at: Optional[float] = None

    def _finalize(self, raw_start: float, raw_end: float) -> Optional[Gap]:
        if raw_end - raw_start < config.MIN_GAP_DURATION_SEC:
            return None
        start = raw_start + config.GAP_MARGIN_SEC
        end = raw_end - config.GAP_MARGIN_SEC
        if end <= start:
            return None
        dur = end - start
        max_chars = max(round(dur * config.SPEECH_RATE_SYLLABLES_PER_SEC), 0)
        if max_chars <= 0:
            return None
        return Gap(round(start, 3), round(end, 3), round(dur, 3), max_chars)

    def push(self, t: float, is_silent: bool) -> List[Gap]:
        finalized = []

        if is_silent:
            if self.mode == "speech":
                if self.pending_gap is not None and (t - self.speech_resumed_at) < config.MIN_MERGE_SPEECH_SEC:
                    self.cur_silence_start = self.pending_gap[0]
                else:
                    self.cur_silence_start = t
                self.pending_gap = None
                self.mode = "silence"
            elif (t - self.cur_silence_start) >= config.MAX_GAP_WAIT_SEC:
                gap = self._finalize(self.cur_silence_start, t)
                if gap:
                    finalized.append(gap)
                self.cur_silence_start = t
        else:
            if self.mode == "silence":
                self.pending_gap = [self.cur_silence_start, t]
                self.speech_resumed_at = t
                self.cur_silence_start = None
                self.mode = "speech"
            elif self.pending_gap is not None and (t - self.speech_resumed_at) >= config.MIN_MERGE_SPEECH_SEC:
                gap = self._finalize(self.pending_gap[0], self.pending_gap[1])
                if gap:
                    finalized.append(gap)
                self.pending_gap = None

        return finalized
