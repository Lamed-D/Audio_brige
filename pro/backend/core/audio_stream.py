import io
import subprocess
from typing import Tuple

import imageio_ffmpeg
import numpy as np
import soundfile as sf

import config


def decode_webm_chunk(data: bytes) -> Tuple[np.ndarray, int]:
    """익스텐션이 보낸 webm/opus 오디오 조각을 mono PCM 으로 디코딩한다.

    각 조각은 MediaRecorder 를 매번 새로 시작해서 만든, 그 자체로 완결된
    webm 파일이어야 한다 (offscreen.js 참고) — 그래야 조각 단위로 독립 디코딩된다.
    """
    ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
    cmd = [
        ffmpeg_exe, "-i", "pipe:0",
        "-f", "wav", "-ac", "1", "-ar", str(config.AUDIO_SAMPLE_RATE),
        "pipe:1",
    ]
    result = subprocess.run(cmd, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode != 0 or not result.stdout:
        raise ValueError(f"오디오 조각 디코딩 실패: {result.stderr.decode(errors='ignore')}")

    samples, sr = sf.read(io.BytesIO(result.stdout), dtype="int16")
    if samples.ndim > 1:
        samples = samples.mean(axis=1)
    return samples, sr


def rms_db_windows(samples: np.ndarray, sr: int, chunk_start_t: float):
    """조각 시작 시각(video_time) 기준으로 (t, db) 창 목록을 계산한다."""
    window = max(int(sr * config.RMS_WINDOW_MS / 1000), 1)
    n_windows = len(samples) // window
    if n_windows == 0:
        return []
    trimmed = samples[: n_windows * window].astype(np.float64)
    reshaped = trimmed.reshape(n_windows, window)
    rms = np.sqrt(np.mean(reshaped ** 2, axis=1))
    ref = 32768.0
    db = 20 * np.log10(np.maximum(rms, 1e-9) / ref)
    times = chunk_start_t + np.arange(n_windows) * (window / sr)
    return list(zip(times.tolist(), db.tolist()))
