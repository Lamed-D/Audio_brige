import os
from pathlib import Path

from dotenv import load_dotenv

# CWD 에 상관없이 이 파일 옆의 .env 를 찾는다 (IDE 실행 설정마다 작업 디렉터리가 다를 수 있어서)
load_dotenv(Path(__file__).resolve().parent / ".env")

BACKEND_DIR = Path(__file__).resolve().parent


def _env_int(
    name: str, default: int, *, minimum: int = 1, maximum: int | None = None
) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} 환경 변수는 정수여야 합니다") from exc
    if value < minimum:
        raise RuntimeError(f"{name} 환경 변수는 {minimum} 이상이어야 합니다")
    if maximum is not None and value > maximum:
        raise RuntimeError(f"{name} 환경 변수는 {maximum} 이하여야 합니다")
    return value


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise RuntimeError(f"{name} 환경 변수는 true 또는 false여야 합니다")


def _env_float(
    name: str,
    default: float,
    *,
    minimum: float = 0.0,
    maximum: float = 1.0,
) -> float:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} 환경 변수는 숫자여야 합니다") from exc
    if not minimum <= value <= maximum:
        raise RuntimeError(f"{name} 환경 변수는 {minimum}~{maximum} 범위여야 합니다")
    return value


# v1 공개 API는 사전 처리 결과를 이 고정 디렉터리에서 조회한다. 상대 경로는
# backend 디렉터리를 기준으로 해석해 실행 CWD에 따라 데이터가 달라지지 않게 한다.
_data_dir_raw = os.environ.get("VOICE_BRIDGE_DATA_DIR", "").strip()
if _data_dir_raw:
    _data_dir_path = Path(_data_dir_raw).expanduser()
    if not _data_dir_path.is_absolute():
        _data_dir_path = BACKEND_DIR / _data_dir_path
    DATA_DIR = _data_dir_path.resolve()
else:
    DATA_DIR = BACKEND_DIR / "data"

_database_path_raw = os.environ.get("VOICE_BRIDGE_DATABASE_PATH", "").strip()
if _database_path_raw:
    _database_path = Path(_database_path_raw).expanduser()
    if not _database_path.is_absolute():
        _database_path = BACKEND_DIR / _database_path
    DATABASE_PATH = _database_path.resolve()
else:
    DATABASE_PATH = DATA_DIR / "voice_bridge.sqlite3"

# 파이프라인이 실행할 때마다 남기는 중간 산출물(오디오/프레임/segments·ocr·script.json/
# 로그) 저장 위치. data/ 와 분리해 둔다 — /v1 은 data/manifests, data/audio 만 서비스하고
# 이 디렉터리는 절대 조회하지 않으므로, 원본 프레임·오디오가 공개될 위험이 구조적으로 없다.
_runs_dir_raw = os.environ.get("VOICE_BRIDGE_RUNS_DIR", "").strip()
if _runs_dir_raw:
    _runs_dir_path = Path(_runs_dir_raw).expanduser()
    if not _runs_dir_path.is_absolute():
        _runs_dir_path = BACKEND_DIR / _runs_dir_path
    PIPELINE_RUNS_DIR = _runs_dir_path.resolve()
else:
    PIPELINE_RUNS_DIR = BACKEND_DIR / "runs"

JOB_RETRY_AFTER_MS = _env_int(
    "VOICE_BRIDGE_RETRY_AFTER_MS", 1500, minimum=1000, maximum=30000
)
MAX_REQUEST_BYTES = _env_int("VOICE_BRIDGE_MAX_REQUEST_BYTES", 16 * 1024 * 1024)
ALLOW_FORCE_REPROCESS = _env_bool("VOICE_BRIDGE_ALLOW_FORCE_REPROCESS", False)

# 로컬 개발 서버도 기본적으로 loopback에만 바인딩하고 debug/reloader를 끈다.
# 외부 서버 배포 시에는 WSGI 서버가 app 객체를 실행하도록 한다.
SERVER_HOST = os.environ.get("VOICE_BRIDGE_SERVER_HOST", "127.0.0.1").strip() or "127.0.0.1"
# 실제 FE(../../chrome-extension-boilerplate-main)의 src/shared/config/constants.ts와
# extension/manifest.json host_permissions가 http://localhost:8000 을 하드코딩하고
# 있다 — 확장 쪽을 바꾸지 않는 한 이 기본값을 8000으로 맞춰야 실제로 연결된다.
SERVER_PORT = _env_int("VOICE_BRIDGE_SERVER_PORT", 8000)
SERVER_DEBUG = _env_bool("VOICE_BRIDGE_SERVER_DEBUG", False)

# 최종 /v1 구조에서는 브라우저가 원본 frame/audio를 업로드하지 않는다. 과금 API를
# 호출할 수 있는 구형 /session 경로는 명시적으로 켠 로컬 개발 환경에서만 허용한다.
LEGACY_SESSION_API_ENABLED = _env_bool(
    "VOICE_BRIDGE_ENABLE_LEGACY_SESSION_API", False
)

# /dev/process 는 카탈로그 등록 + 유튜브 다운로드 + M1~M5 파이프라인을 하나의
# HTTP 요청으로 실행하는 로컬 편의 도구다. /v1 과 달리 임의 video_id 를 그대로
# 받아 실제 다운로드와 과금 API 호출을 일으키므로, 이 서버를 127.0.0.1 밖으로
# 노출할 계획이 있다면 반드시 꺼야 한다.
DEV_PIPELINE_API_ENABLED = _env_bool("VOICE_BRIDGE_ENABLE_DEV_PIPELINE_API", True)

# 로컬 POC 호환을 위해 기본값은 전체 origin이다. 배포/공유 환경에서는 실제
# chrome-extension://<extension-id> 값만 쉼표로 나열해 제한한다.
_cors_raw = os.environ.get("VOICE_BRIDGE_CORS_ORIGINS", "*")
CORS_ALLOWED_ORIGINS = [item.strip() for item in _cors_raw.split(",") if item.strip()] or ["*"]

# 실시간 캡처 (조각 길이·프레임 주기는 extension/offscreen.js 쪽 상수가 실제 기준이다)
FRAME_BUFFER_WINDOW_SEC = 20.0  # gap 이 끝난 뒤에도 그 구간 프레임을 찾을 수 있도록 보관하는 길이
RMS_WINDOW_MS = 50.0
SILENCE_DB = -40.0
SESSION_IDLE_TIMEOUT_SEC = 600  # 이 시간 동안 업로드가 없으면 세션을 정리한다

# 6.1 무음 구간 정제
MIN_MERGE_SPEECH_SEC = 0.3     # 이보다 짧은 발화로 갈라진 두 gap 은 하나로 합친다
MIN_GAP_DURATION_SEC = 1.5     # 이보다 짧은 gap 은 버린다
GAP_MARGIN_SEC = 0.3           # gap 앞뒤로 비워 두는 여유
MAX_GAPS_PER_WINDOW = 3        # 밀집도 제한: 아래 창 안에서 허용하는 최대 삽입 수
DENSITY_WINDOW_SEC = 30.0
MAX_GAP_WAIT_SEC = 6.0          # 무음이 이보다 길게 이어지면 기다리지 않고 그 시점에서 끊어 확정한다

# 6.2 글자 수 계산
SPEECH_RATE_SYLLABLES_PER_SEC = 5.0

# M4 서술 생성
DESCRIBE_MAX_RETRIES = 1
DUPLICATE_SIMILARITY_THRESHOLD = 0.8   # 직전 서술/대사와 이 이상 유사하면 중복으로 skip
OCR_MATCH_SIMILARITY_THRESHOLD = 0.6   # 화면 텍스트가 대사와 이 이상 유사하면 in_speech=True

# M5 음성 합성
TTS_MAX_SPEED = 1.4
TTS_MIN_SPEED = 0.8

# 세션 기본 모드: "text" 면 서술 텍스트만 만들고 TTS 는 건너뛴다 (알고리즘 검증용, 비용 절감).
# "tts" 로 바꾸면 narrator.py 의 동일한 흐름에 음성 합성 단계만 추가로 켜진다.
NARRATION_MODE_DEFAULT = os.environ.get("NARRATION_MODE_DEFAULT", "text")

# 원본 볼륨 덕킹은 익스텐션 쪽(content.js DUCK_LEVEL)에서 실시간으로 처리한다.

# 어댑터 (OpenAI 참조 구현)
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
OPENAI_TRANSCRIBE_MODEL = os.environ.get("OPENAI_TRANSCRIBE_MODEL", "whisper-1")
OPENAI_VISION_MODEL = os.environ.get("OPENAI_VISION_MODEL", "gpt-5.6")
OPENAI_REASONING_EFFORT = os.environ.get("OPENAI_REASONING_EFFORT", "high").strip().lower()
if OPENAI_REASONING_EFFORT not in {"none", "low", "medium", "high", "xhigh", "max"}:
    raise RuntimeError(
        "OPENAI_REASONING_EFFORT는 none, low, medium, high, xhigh, max 중 하나여야 합니다"
    )
OPENAI_TTS_MODEL = os.environ.get("OPENAI_TTS_MODEL", "tts-1")
OPENAI_TTS_VOICE = os.environ.get("OPENAI_TTS_VOICE", "onyx")

AUDIO_SAMPLE_RATE = 16000

# ---- BE-02~BE-06: 사전 처리 파이프라인 (pipeline/) ----
# 공개 manifest 음성 포맷은 스펙(4.2, 부록 B)에서 고정값이다. 여기서 바꾸면
# core.storage._validate_manifest_audio 의 실측 검증과 어긋나므로 함께 맞춘다.
MANIFEST_VOICE_ID = os.environ.get("VOICE_BRIDGE_VOICE_ID", "ko-KR-poc")
MANIFEST_SAMPLE_RATE_HZ = 24_000

# 부록 B. 권장 상수
PLAYBACK_DUCK_FACTOR = 0.35
PLAYBACK_PRELOAD_COUNT = 3
PLAYBACK_LOOKAHEAD_MS = 500
PLAYBACK_LATE_TOLERANCE_MS = 250
PLAYBACK_AUTO_PAUSE_DEFAULT = True
PLAYBACK_MAX_EXTENDED_DURATION_MS = 8_000
PLAYBACK_MIN_EXTENDED_INTERVAL_MS = 15_000
PLAYBACK_SAFETY_MARGIN_MS = 250

# M5: TTS 가 구간 길이를 넘으면 프론트 재생속도로 맞추지 않고 M4 를 다시 불러
# 이 비율만큼 글자 수를 줄여 재합성한다 (스펙 4.2 "M4 축약 후 재합성").
SHORTEN_MAX_CHARS_RATIO = 0.7

# M1: gap 1초마다 시작·중간·끝 3장을 캡처한다. 길게 이어지는 무음 구간에서
# 프레임이 과도하게 쌓이는 것을 막기 위해, 실제로 모델에 보내는 개수는 아래
# 상한까지만 균등 샘플링한다 (OCR 은 이미지 하나당 비용이 싸고 정지 텍스트를
# 놓치면 안 되므로 상한을 더 높게 둔다).
MAX_OCR_FRAMES_PER_GAP = 18
MAX_DESCRIBE_FRAMES_PER_GAP = 18

# 성능 우선 문맥 분석: 각 gap 앞뒤 장면과 영상 전체의 대표 장면을 함께 본다.
GAP_CONTEXT_WINDOW_MS = _env_int("VOICE_BRIDGE_GAP_CONTEXT_WINDOW_MS", 3_000)
OVERVIEW_FRAME_INTERVAL_SEC = _env_int("VOICE_BRIDGE_OVERVIEW_FRAME_INTERVAL_SEC", 10)
MAX_OVERVIEW_FRAMES = _env_int("VOICE_BRIDGE_MAX_OVERVIEW_FRAMES", 36)
DESCRIBE_CONTEXT_BEFORE_SEGMENTS = _env_int(
    "VOICE_BRIDGE_CONTEXT_BEFORE_SEGMENTS", 8
)
DESCRIBE_CONTEXT_AFTER_SEGMENTS = _env_int(
    "VOICE_BRIDGE_CONTEXT_AFTER_SEGMENTS", 4
)
# 8초 extended 해설에 들어갈 수 있는 한국어 글자 수의 보수적 상한.
EXTENDED_MAX_CHARS = _env_int("VOICE_BRIDGE_EXTENDED_MAX_CHARS", 38)

# 초당 3장 캡처 자체는 유지하되, 모델 호출 전에 같은 gap 안의 거의 같은 프레임을 로컬에서
# 제거한다. 0.985는 dHash 한 비트만 달라도 보존하는 보수적인 기본값이라 자막이
# 점차 완성되는 장면을 통째로 지울 가능성을 낮춘다. 같은 묶음에서는 마지막
# 프레임을 남겨 불완전한 초반 글자보다 완성된 화면을 OCR에 전달한다.
FRAME_SIMILARITY_THRESHOLD = _env_float(
    "VOICE_BRIDGE_FRAME_SIMILARITY_THRESHOLD", 0.985, minimum=0.8, maximum=1.0
)

# OpenAI Vision 이미지 detail. 장면 설명은 저비용 512px 입력으로 충분한 경우가
# 많고, 작은 화면 글자를 읽는 OCR은 high가 안전하다. .env에서 조절 가능하다.
OPENAI_OCR_IMAGE_DETAIL = os.environ.get("OPENAI_OCR_IMAGE_DETAIL", "high").strip().lower()
OPENAI_VLM_IMAGE_DETAIL = os.environ.get("OPENAI_VLM_IMAGE_DETAIL", "original").strip().lower()
if OPENAI_OCR_IMAGE_DETAIL not in {"low", "high", "auto"}:
    raise RuntimeError("OPENAI_OCR_IMAGE_DETAIL은 low, high, auto 중 하나여야 합니다")
if OPENAI_VLM_IMAGE_DETAIL not in {"low", "high", "auto", "original"}:
    raise RuntimeError("OPENAI_VLM_IMAGE_DETAIL은 low, high, auto, original 중 하나여야 합니다")

# M4: 서술 프롬프트에 넣는 직전 대사 컨텍스트를 몇 문장까지 줄지. 한 줄만 주면
# "아까 이미 말한 정보"를 모델이 재확인하지 못해 같은 내용을 다시 서술하기 쉽다.
DESCRIBE_CONTEXT_SPEECH_SEGMENTS = DESCRIBE_CONTEXT_BEFORE_SEGMENTS
