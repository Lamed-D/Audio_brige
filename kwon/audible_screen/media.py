from __future__ import annotations

import json
import os
import shutil
import subprocess
import wave
from pathlib import Path

try:
    from pydub import AudioSegment
except ImportError:  # --help와 순수 로직 테스트는 의존성 설치 전에도 동작한다.
    AudioSegment = None


class DependencyError(RuntimeError):
    pass


def configure_media_tools() -> bool:
    """FFmpeg를 PATH와 Windows의 대표 설치 위치에서 찾아 등록한다."""
    if shutil.which("ffmpeg") and shutil.which("ffprobe"):
        return True

    candidates: list[Path] = []
    configured_bin = os.getenv("FFMPEG_BIN")
    if configured_bin:
        candidates.append(Path(configured_bin).expanduser())

    local_app_data = os.getenv("LOCALAPPDATA")
    if local_app_data:
        winget_root = Path(local_app_data) / "Microsoft" / "WinGet" / "Packages"
        package_root = (
            winget_root
            / "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe"
        )
        if package_root.is_dir():
            try:
                candidates.extend(package_root.glob("ffmpeg-*-full_build/bin"))
                candidates.extend(package_root.glob("ffmpeg-*-essentials_build/bin"))
            except OSError:
                pass
        candidates.append(Path(local_app_data) / "Microsoft" / "WinGet" / "Links")

    candidates.extend(
        [
            Path("C:/ffmpeg/bin"),
            Path("C:/Program Files/ffmpeg/bin"),
            Path("C:/ProgramData/chocolatey/bin"),
        ]
    )

    for bin_dir in candidates:
        if (bin_dir / "ffmpeg.exe").is_file() and (bin_dir / "ffprobe.exe").is_file():
            os.environ["PATH"] = f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}"
            return True
    return False


def media_tools_ready() -> bool:
    return configure_media_tools()


def require_media_tools() -> None:
    configure_media_tools()
    missing = [name for name in ("ffmpeg", "ffprobe") if shutil.which(name) is None]
    if missing:
        raise DependencyError(
            f"필수 프로그램이 PATH에 없습니다: {', '.join(missing)}. "
            "README의 ffmpeg 설치 안내를 따라 설치한 뒤 터미널을 다시 여세요."
        )


def run(command: list[str]) -> None:
    completed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8")
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise RuntimeError(f"명령 실행 실패: {' '.join(command)}\n{detail}")


def probe_duration(media_path: Path) -> float:
    completed = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "json", str(media_path),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
    )
    return float(json.loads(completed.stdout)["format"]["duration"])


def extract_audio(video_path: Path, original_wav: Path, speech_wav: Path) -> None:
    run(["ffmpeg", "-y", "-i", str(video_path), "-vn", "-ac", "2", "-ar", "48000", str(original_wav)])
    run(["ffmpeg", "-y", "-i", str(video_path), "-vn", "-ac", "1", "-ar", "16000", str(speech_wav)])


def extract_speech_audio(video_path: Path, speech_wav: Path) -> None:
    """VAD/STT용 16kHz mono 오디오를 추출한다.

    확장자가 mp3이면 API 업로드 크기를 줄이기 위해 64kbps로 압축한다.
    로컬 Whisper 호환을 위해 wav 출력도 계속 지원한다.
    """
    command = [
        "ffmpeg", "-y", "-i", str(video_path), "-vn", "-ac", "1", "-ar", "16000",
    ]
    if speech_wav.suffix.lower() == ".mp3":
        command.extend(["-codec:a", "libmp3lame", "-b:a", "64k"])
    command.append(str(speech_wav))
    run(command)


def extract_audio_chunk(
    audio_path: Path,
    start: float,
    duration: float,
    output_path: Path,
) -> None:
    """API 병렬 전사를 위해 압축 오디오 조각을 만든다."""
    run(
        [
            "ffmpeg",
            "-y",
            "-ss",
            f"{start:.3f}",
            "-t",
            f"{duration:.3f}",
            "-i",
            str(audio_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-codec:a",
            "libmp3lame",
            "-b:a",
            "64k",
            str(output_path),
        ]
    )


def capture_frame(video_path: Path, at_seconds: float, output_path: Path) -> None:
    run([
        "ffmpeg", "-y", "-ss", f"{at_seconds:.3f}", "-i", str(video_path),
        "-frames:v", "1", "-vf", "scale='min(1280,iw)':-2", "-q:v", "3",
        str(output_path),
    ])


def fit_wav_to_duration(input_path: Path, output_path: Path, target_duration: float) -> float:
    """피치를 유지한 채 WAV 속도를 높여 지정 구간 안에 맞춘다."""
    actual = wav_duration(input_path)
    if target_duration <= 0 or actual <= 0:
        raise ValueError("오디오 길이는 0보다 커야 합니다.")
    ratio = actual / target_duration
    if ratio <= 1.0:
        shutil.copy2(input_path, output_path)
        return actual
    if ratio > 2.0:
        raise ValueError("두 배를 넘는 음성 가속은 지원하지 않습니다.")
    run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(input_path),
            "-filter:a",
            f"atempo={ratio:.5f}",
            str(output_path),
        ]
    )
    return wav_duration(output_path)


def wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as audio:
        return audio.getnframes() / float(audio.getframerate())


def mix_descriptions(
    original_wav: Path,
    items: list[dict],
    output_wav: Path,
    duck_db: float = 6.0,
) -> None:
    if AudioSegment is None:
        raise DependencyError("pydub가 없습니다. pip install -r requirements.txt 를 실행하세요.")
    mixed = AudioSegment.from_wav(original_wav)
    for item in items:
        clip_value = item.get("clip")
        if item.get("status") != "ready" or not clip_value:
            continue

        clip = AudioSegment.from_wav(clip_value)
        position = int(float(item["start"]) * 1000)
        finish = min(len(mixed), position + len(clip))
        background = mixed[position:finish].apply_gain(-abs(duck_db))
        replacement = background.overlay(clip[: len(background)])
        mixed = mixed[:position] + replacement + mixed[finish:]

    mixed.export(output_wav, format="wav")


def mux_video(video_path: Path, audio_path: Path, output_path: Path) -> None:
    run([
        "ffmpeg", "-y", "-i", str(video_path), "-i", str(audio_path),
        "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy",
        "-c:a", "aac", "-b:a", "192k", "-shortest", str(output_path),
    ])


def mix_narrations_with_video(
    video_path: Path, items: list[dict], output_path: Path
) -> None:
    """원본 오디오에 구간별 TTS를 지연 배치하고 MP4로 묶는다."""
    ready = [item for item in items if item.get("clip")]
    if not ready:
        raise ValueError("합성할 TTS 클립이 없습니다.")

    command = ["ffmpeg", "-y", "-i", str(video_path)]
    for item in ready:
        command.extend(["-i", str(item["clip"])])

    filters: list[str] = []
    narration_labels: list[str] = []
    for input_index, item in enumerate(ready, start=1):
        delay_ms = max(0, round(float(item["start"]) * 1000))
        label = f"narration_{input_index}"
        filters.append(
            f"[{input_index}:a]volume=1.35,adelay={delay_ms}:all=1[{label}]"
        )
        narration_labels.append(f"[{label}]")

    mix_inputs = "[0:a]" + "".join(narration_labels)
    filters.append(
        f"{mix_inputs}amix=inputs={len(ready) + 1}:duration=first:"
        "dropout_transition=0:normalize=0[aout]"
    )
    command.extend(
        [
            "-filter_complex",
            ";".join(filters),
            "-map",
            "0:v:0",
            "-map",
            "[aout]",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
            "-shortest",
            str(output_path),
        ]
    )
    run(command)


def extract_audio_track(video_path: Path, output_path: Path) -> None:
    run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(video_path),
            "-vn",
            "-c:a",
            "copy",
            str(output_path),
        ]
    )
