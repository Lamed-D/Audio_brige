"""M5: 고정 음성 합성 + 공개 포맷(PCM 16-bit mono 24kHz) 강제 변환.

어댑터가 어떤 포맷을 반환하든, core.storage._validate_manifest_audio 가 요구하는
정확한 포맷으로 다시 인코딩해서 검증 실패가 어댑터 구현에 좌우되지 않게 한다.
"""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path
from typing import Tuple

import imageio_ffmpeg
import soundfile as sf

import config
from adapters.base import ModelAdapter


def synthesize(adapter: ModelAdapter, text: str) -> Tuple[bytes, int]:
    """(wav_bytes, duration_ms) 를 반환한다. speed 는 항상 1.0 이다 — 재생속도로
    길이를 맞추는 것은 스펙에서 금지되어 있고(M4 축약이 유일한 해법), 합성
    자체도 고정 속도여야 재현 가능하다."""
    with tempfile.TemporaryDirectory() as tmp_dir:
        raw_path = str(Path(tmp_dir) / "raw.wav")
        adapter.speak(text, raw_path, speed=1.0)

        fixed_path = str(Path(tmp_dir) / "fixed.wav")
        ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
        cmd = [
            ffmpeg_exe, "-y", "-i", raw_path,
            "-ac", "1", "-ar", str(config.MANIFEST_SAMPLE_RATE_HZ),
            "-sample_fmt", "s16", "-acodec", "pcm_s16le",
            fixed_path,
        ]
        result = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        if result.returncode != 0:
            raise RuntimeError(f"TTS 재인코딩 실패: {result.stderr.decode(errors='ignore')}")

        duration_ms = round(sf.info(fixed_path).duration * 1000)
        return Path(fixed_path).read_bytes(), duration_ms
