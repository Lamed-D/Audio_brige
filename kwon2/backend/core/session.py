import shutil
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Dict, List, Optional

import config
from core.silence import GapDetector


class SessionState:
    def __init__(self, mode: Optional[str] = None):
        self.id = uuid.uuid4().hex[:12]
        self.mode = mode or config.NARRATION_MODE_DEFAULT  # "text" | "tts"
        self.tmp_dir = Path(tempfile.mkdtemp(prefix=f"soundbridge_{self.id}_"))
        (self.tmp_dir / "frames").mkdir()
        (self.tmp_dir / "clips").mkdir()

        self.gap_detector = GapDetector()
        self.frame_buffer: List[dict] = []       # [{t, path}], video_time 오름차순
        self.recent_speech: List[dict] = []       # [{start, end, text}]
        self.narration_history: List[dict] = []   # [{t, text}] — 중복 판정 + 밀집도 제한
        self.ready: List[dict] = []               # 아직 익스텐션이 못 받아간 서술

        self._frame_idx = 0
        self._clip_idx = 0
        self._narration_idx = 0

        self.lock = threading.Lock()
        self.last_activity = time.time()

    def touch(self):
        self.last_activity = time.time()

    def add_frame(self, video_time: float, data: bytes) -> str:
        self._frame_idx += 1
        path = self.tmp_dir / "frames" / f"frame_{self._frame_idx:06d}.jpg"
        path.write_bytes(data)
        self.frame_buffer.append({"t": video_time, "path": str(path)})
        self.frame_buffer.sort(key=lambda f: f["t"])
        cutoff = video_time - config.FRAME_BUFFER_WINDOW_SEC
        self.frame_buffer = [f for f in self.frame_buffer if f["t"] >= cutoff]
        return str(path)

    def frames_in(self, start: float, end: float) -> List[str]:
        return [f["path"] for f in self.frame_buffer if start <= f["t"] <= end]

    def add_speech(self, start: float, end: float, text: str):
        if not text.strip():
            return
        self.recent_speech.append({"start": start, "end": end, "text": text.strip()})
        cutoff = end - 60.0
        self.recent_speech = [s for s in self.recent_speech if s["end"] >= cutoff]

    def context_before(self, t: float) -> Optional[str]:
        prior = [s for s in self.recent_speech if s["end"] <= t]
        return prior[-1]["text"] if prior else None

    def next_clip_path(self) -> str:
        self._clip_idx += 1
        return str(self.tmp_dir / "clips" / f"clip_{self._clip_idx:05d}.wav")

    def density_ok_and_record(self, t: float) -> bool:
        window = [n for n in self.narration_history if t - n["t"] <= config.DENSITY_WINDOW_SEC]
        if len(window) >= config.MAX_GAPS_PER_WINDOW:
            return False
        return True

    def record_narration(self, t: float, text: str):
        self.narration_history.append({"t": t, "text": text})
        cutoff = t - config.DENSITY_WINDOW_SEC
        self.narration_history = [n for n in self.narration_history if n["t"] >= cutoff]

    def enqueue_ready(self, gap, text: str, source: str, confidence: str,
                       clip_path: Optional[str], duration: float):
        self._narration_idx += 1
        item = {
            "id": self._narration_idx,
            "gap_start": gap.start,
            "gap_end": gap.end,
            "text": text,
            "source": source,
            "confidence": confidence,
            "clip_path": clip_path,
            "duration": duration,
        }
        self.ready.append(item)
        return item

    def pop_ready(self) -> List[dict]:
        items, self.ready = self.ready, []
        return items

    def cleanup(self):
        shutil.rmtree(self.tmp_dir, ignore_errors=True)


class SessionRegistry:
    def __init__(self):
        self._sessions: Dict[str, SessionState] = {}
        self._lock = threading.Lock()

    def create(self, mode: Optional[str] = None) -> SessionState:
        self._sweep()
        s = SessionState(mode=mode)
        with self._lock:
            self._sessions[s.id] = s
        return s

    def get(self, session_id: str) -> Optional[SessionState]:
        return self._sessions.get(session_id)

    def remove(self, session_id: str):
        with self._lock:
            s = self._sessions.pop(session_id, None)
        if s:
            s.cleanup()

    def _sweep(self):
        now = time.time()
        stale = [sid for sid, s in self._sessions.items()
                 if now - s.last_activity > config.SESSION_IDLE_TIMEOUT_SEC]
        for sid in stale:
            self.remove(sid)


registry = SessionRegistry()
