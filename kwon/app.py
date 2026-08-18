from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path
from uuid import uuid4

import streamlit as st
from dotenv import load_dotenv

from audible_screen.input_source import download_video_url, save_upload
from audible_screen.media import media_tools_ready
from audible_screen.speech import OpenAISpeechDetector, SpeechDetector
from audible_screen.tts import SpeechSynthesizer
from audible_screen.vision import SceneAnalyzer
from audible_screen.workflow import AnalysisConfig, analyze_video


BASE_DIR = Path(__file__).resolve().parent
OUTPUT_ROOT = BASE_DIR / "data" / "output"
CACHE_ROOT = BASE_DIR / "data" / "cache"
ALLOWED_EXTENSIONS = ["mp4", "mov", "mkv", "webm", "avi", "m4v"]

load_dotenv(BASE_DIR / ".env")

st.set_page_config(page_title="들리는 화면 분석기", page_icon="🔊", layout="wide")


@st.cache_resource(show_spinner=False)
def get_speech_detector(provider: str, model_name: str) -> object:
    if provider == "OpenAI API (빠름)":
        return OpenAISpeechDetector(
            model_name="whisper-1", chunk_seconds=120, max_workers=3
        )
    return SpeechDetector(model_name)


def new_job_dir() -> Path:
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    job_dir = OUTPUT_ROOT / f"job_{stamp}_{uuid4().hex[:6]}"
    job_dir.mkdir(parents=True, exist_ok=False)
    return job_dir


def result_table(results: list[dict]) -> list[dict]:
    return [
        {
            "구간": item["id"],
            "시작(초)": item["start"],
            "끝(초)": item["end"],
            "분류": item["source"],
            "안정된 글자": item["stable_text"],
            "음성에 없던 화면 글자": item.get("new_screen_text", ""),
            "지시어 확인": item.get("resolved_reference", ""),
            "장면 설명": item["scene_description"],
            "최종 후보": item["narration"],
            "확신도": item["confidence"],
            "자동 검증": item.get("validation", ""),
            "사용 모델": item.get("model_used", ""),
            "판단 근거": item["reason"],
        }
        for item in results
    ]


st.title("🔊 들리는 화면 — 영상 빈 구간 분석기")
st.caption("사람의 말이 없는 구간을 찾아 핵심 화면만 자동 해설하고 음성으로 만듭니다.")
st.info(
    "확실한 화면 정보만 읽도록 자동 검증합니다. 판단 근거가 부족한 구간은 "
    "틀린 해설을 만드는 대신 건너뜁니다."
)

with st.sidebar:
    st.header("분석 설정")
    speech_provider = st.selectbox(
        "음성 인식 방식", ["OpenAI API (빠름)", "로컬 Whisper (느림)"], index=0
    )
    whisper_model = "small"
    if speech_provider == "로컬 Whisper (느림)":
        whisper_model = st.selectbox("로컬 Whisper 모델", ["base", "small", "medium"], index=1)
    min_gap = st.slider("최소 무발화 구간(초)", 1.0, 5.0, 2.0, 0.1)
    safety_margin = st.slider("대사 앞뒤 안전 여백(초)", 0.1, 1.0, 0.3, 0.1)
    max_gaps = st.slider("최대 화면 분석 구간 수", 1, 40, 20)
    max_keyframes = st.select_slider("구간당 핵심 프레임", options=[3, 4, 5, 6], value=4)
    vision_workers = st.slider("동시 화면 분석 수", 1, 5, 3)
    st.caption("후보 7장을 먼저 비교하고 장면 변화가 큰 핵심 프레임만 API에 보냅니다.")
    vision_model = st.text_input(
        "빠른 Vision 모델",
        value=os.getenv("OPENAI_VISION_MODEL", "gpt-4o-mini"),
        help="계정에서 사용할 수 있는 이미지 입력·구조화 출력 지원 모델을 입력하세요.",
    )
    use_fallback = st.checkbox("어려운 장면만 정밀 모델로 재분석", value=True)
    fallback_model = ""
    if use_fallback:
        fallback_model = st.text_input(
            "정밀 Vision 모델",
            value=os.getenv("OPENAI_VISION_FALLBACK_MODEL", "gpt-4o"),
        )
    enable_tts = st.checkbox("TTS 및 접근성 영상 생성", value=True)
    tts_model = st.text_input(
        "TTS 모델", value=os.getenv("OPENAI_TTS_MODEL", "gpt-4o-mini-tts")
    )
    tts_voice = st.selectbox(
        "TTS 음성", ["coral", "alloy", "nova", "sage", "shimmer"], index=0
    )
    make_output_video = st.checkbox("결과 MP4 파일까지 만들기", value=True)
    st.caption("처음에는 기본값을 권장합니다. 같은 영상의 음성 분석은 자동으로 재사용됩니다.")

api_key_ready = bool(os.getenv("OPENAI_API_KEY"))
ffmpeg_ready = media_tools_ready()

status_col1, status_col2 = st.columns(2)
status_col1.metric("OpenAI API 키", "준비됨" if api_key_ready else "입력 필요")
status_col2.metric("FFmpeg", "준비됨" if ffmpeg_ready else "설치 필요")

input_type = st.radio("영상 입력 방법", ["파일 업로드", "영상 URL"], horizontal=True)
uploaded_file = None
video_url = ""
if input_type == "파일 업로드":
    uploaded_file = st.file_uploader(
        "분석할 동영상을 선택하세요",
        type=ALLOWED_EXTENSIONS,
        help="최대 500MB, 테스트는 15분 이하 영상을 권장합니다.",
    )
else:
    video_url = st.text_input(
        "공개 영상 URL",
        placeholder="https://example.com/video 또는 공개 영상 페이지 URL",
    )
    st.caption("DRM, 로그인 필요 영상, 비공개 영상, 사이트 정책상 다운로드가 제한된 영상은 실패할 수 있습니다.")

analyze_clicked = st.button("분석 시작", type="primary", use_container_width=True)

st.subheader("처리 로그")
log_placeholder = st.empty()
progress_bar = st.progress(0.0)

if "analysis_logs" not in st.session_state:
    st.session_state.analysis_logs = ["분석을 시작하면 단계별 로그가 여기에 표시됩니다."]
if "analysis_result" not in st.session_state:
    st.session_state.analysis_result = None


def render_logs() -> None:
    log_placeholder.code("\n".join(st.session_state.analysis_logs[-250:]), language=None)


render_logs()

if analyze_clicked:
    st.session_state.analysis_logs = []
    st.session_state.analysis_result = None

    def log(message: str) -> None:
        now = datetime.now().strftime("%H:%M:%S")
        st.session_state.analysis_logs.append(f"[{now}] {message}")
        render_logs()

    def progress(done: int, total: int) -> None:
        progress_bar.progress(done / total if total else 1.0)

    try:
        if not api_key_ready:
            raise RuntimeError("kwon/.env의 OPENAI_API_KEY= 뒤에 API 키를 입력하세요.")
        if not ffmpeg_ready:
            raise RuntimeError("FFmpeg/FFprobe가 없습니다. 사용설명서의 설치 단계를 먼저 진행하세요.")
        if input_type == "파일 업로드" and uploaded_file is None:
            raise RuntimeError("분석할 영상 파일을 선택하세요.")
        if input_type == "영상 URL" and not video_url.strip():
            raise RuntimeError("분석할 영상 URL을 입력하세요.")

        job_dir = new_job_dir()
        log(f"작업 폴더를 만들었습니다: {job_dir.name}")
        if input_type == "파일 업로드":
            assert uploaded_file is not None
            video_path = save_upload(uploaded_file.getvalue(), uploaded_file.name, job_dir)
            log(f"업로드 파일을 저장했습니다: {video_path.name}")
        else:
            video_path = download_video_url(
                video_url, job_dir, log, cache_dir=CACHE_ROOT
            )
            log(f"URL 영상을 저장했습니다: {video_path.name}")

        log(f"음성 인식을 준비합니다: {speech_provider}")
        detector = get_speech_detector(speech_provider, whisper_model)
        analyzer = SceneAnalyzer(
            vision_model=vision_model.strip(),
            fallback_model=fallback_model.strip(),
        )
        synthesizer = (
            SpeechSynthesizer(model=tts_model.strip(), voice=tts_voice)
            if enable_tts
            else None
        )
        config = AnalysisConfig(
            min_gap=min_gap,
            safety_margin=safety_margin,
            max_gaps=max_gaps,
            max_keyframes=max_keyframes,
            vision_workers=vision_workers,
            make_output_video=make_output_video,
        )
        result = analyze_video(
            video_path=video_path,
            job_dir=job_dir,
            detector=detector,
            analyzer=analyzer,
            config=config,
            log=log,
            progress=progress,
            synthesizer=synthesizer,
            cache_dir=CACHE_ROOT,
        )
        st.session_state.analysis_result = result
        progress_bar.progress(1.0)
        st.success("분석이 완료되었습니다.")
    except Exception as exc:
        log(f"오류: {exc}")
        st.error(str(exc))

result = st.session_state.analysis_result
if result:
    st.divider()
    st.subheader("분석 결과")
    metric_cols = st.columns(5)
    metric_cols[0].metric("영상 길이", f"{result['duration']:.1f}초")
    metric_cols[1].metric("발화 구간", result["speech_count"])
    metric_cols[2].metric("전체 gap", result["gap_count"])
    metric_cols[3].metric("분석 gap", result["analyzed_count"])
    metric_cols[4].metric(
        "해설 후보",
        sum(1 for item in result["results"] if item["narration"]),
    )

    if result["results"]:
        st.dataframe(result_table(result["results"]), use_container_width=True, hide_index=True)
    else:
        st.warning("설정한 길이 이상의 무발화 구간이 없습니다. 최소 gap을 줄이거나 다른 영상을 시험하세요.")

    download_json = json.dumps(result, ensure_ascii=False, indent=2)
    st.download_button(
        "결과 JSON 다운로드",
        data=download_json,
        file_name="script.json",
        mime="application/json",
    )

    subtitle_cols = st.columns(2)
    speech_srt_path = Path(result["speech_srt"])
    accessible_srt_path = Path(result["accessible_srt"])
    subtitle_cols[0].download_button(
        "음성 자막 SRT 다운로드",
        data=speech_srt_path.read_bytes(),
        file_name="speech.srt",
        mime="application/x-subrip",
    )
    subtitle_cols[1].download_button(
        "화면해설 통합 SRT 다운로드",
        data=accessible_srt_path.read_bytes(),
        file_name="accessible.srt",
        mime="application/x-subrip",
    )

    if result.get("output_audio"):
        st.subheader("접근성 음성")
        st.audio(result["output_audio"])
        st.caption(f"저장 위치: {result['output_audio']}")
    if result.get("output_video"):
        st.subheader("화면해설 적용 영상")
        st.video(result["output_video"])
        st.caption(f"저장 위치: {result['output_video']}")

    st.subheader("구간별 프레임 비교")
    for item in result["results"]:
        title = (
            f"{item['id']} · {item['start']:.2f}~{item['end']:.2f}초 · "
            f"{item['source']} · {item['narration'] or '건너뜀'}"
        )
        with st.expander(title):
            columns = st.columns(3)
            for frame_index, (frame, timestamp) in enumerate(
                zip(item["frames"], item["frame_times"])
            ):
                columns[frame_index % 3].image(
                    frame, caption=f"{timestamp:.2f}초", use_container_width=True
                )
            st.json(
                {
                    "stable_text": item["stable_text"],
                    "new_screen_text": item.get("new_screen_text", ""),
                    "resolved_reference": item.get("resolved_reference", ""),
                    "scene_description": item["scene_description"],
                    "narration": item["narration"],
                    "source": item["source"],
                    "confidence": item["confidence"],
                    "validation": item.get("validation", ""),
                    "model_used": item.get("model_used", ""),
                    "fallback_used": item.get("fallback_used", False),
                    "reason": item["reason"],
                    "tts_status": item.get("tts_status", "분석만 실행"),
                }
            )
