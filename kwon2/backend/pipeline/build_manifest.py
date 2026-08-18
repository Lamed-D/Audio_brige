"""BE-02~BE-06: M1~M5 를 순서대로 실행해 v1 manifest 를 게시하는 오케스트레이터.

/v1 API(BE-07)와 저장소(core.storage)는 이미 완성되어 있지만, 그것들이 서비스할
manifest/clip 을 실제로 만드는 사전 처리 파이프라인이 없었다. 이 스크립트가
그 빈 자리다: 로컬 영상 파일 하나를 받아 전사 -> 무음 구간 -> 화면해설 텍스트
-> TTS -> 검증된 manifest 순서로 처리하고, 통과한 결과만 게시한다.

실행할 때마다 config.PIPELINE_RUNS_DIR 아래에 그 실행만의 작업 디렉터리를 남긴다
(원래 MVP 설계의 "모든 모듈은 파일로 통신한다" 원칙) — 무음 구간만 계산하고
끝나는 게 아니라, 실제로 무엇을 보고 무엇을 판단했는지 나중에도 확인할 수 있어야
하기 때문이다:

  runs/{provider}/{video_id}/r{revision}/
    audio.wav          M1 전체 오디오
    overview_frames/*.jpg  M3 전체 인물·장소 파악용 대표 프레임
    program_context.json   M3 전체 자막+대표 프레임에서 확인한 사실 사전
    frames/*.jpg           M1 gap 앞·내부·뒤 프레임
    segments.json          M2 전사 + 무음 구간
    ocr.json               구형 독립 OCR 호환 로그(통합 VLM 모드에서는 빈 배열)
    script.json            M4 gap 별 최종 판단 (게시/스킵과 그 이유)
    pipeline.log           이 실행의 로그

브라우저는 이 과정에 관여하지 않는다(연동규격 8.1) — 이 디렉터리는 /v1 이 조회
하는 data/ 와 분리되어 있어 원본 영상/오디오/프레임이 공개 데이터로 나갈 수
없다.
"""

from __future__ import annotations

import argparse
import contextlib
import dataclasses
import json
import logging
import sys
import tempfile
from pathlib import Path
from typing import Callable, Optional

import config
from adapters.base import ModelAdapter
from adapters.openai_adapter import OpenAIAdapter
from core.contracts import DURATION_TOLERANCE_MS, ContractValidationError
from core.storage import CatalogInvalid, FileRepository, ManifestInvalid
from pipeline import media, tts
from pipeline.fetch_youtube import download_youtube
from pipeline.gaps import build_gaps
from pipeline.narrate import _pick_frames, decide
from pipeline.subtitle import build_srt

log = logging.getLogger("soundbridge.pipeline")
# run_pipeline() 은 CLI(main() 이 logging.basicConfig 를 호출)뿐 아니라 라이브러리로도
# 호출된다(api/dev.py, 테스트) — 그런 호출자는 로깅을 설정하지 않으므로, 이 로거의
# 유효 레벨이 root 의 기본값(WARNING)으로 남아 info() 호출이 통째로 버려질 수 있다.
# run 디렉터리의 pipeline.log 가 항상 채워지도록 여기서 직접 레벨을 고정한다.
log.setLevel(logging.INFO)


class PipelineError(RuntimeError):
    pass


@contextlib.contextmanager
def _run_log_file(log_path: Path):
    """이 실행의 log.* 호출을 콘솔뿐 아니라 run 디렉터리 파일에도 남긴다."""
    log_path.parent.mkdir(parents=True, exist_ok=True)
    handler = logging.FileHandler(log_path, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    handler.setLevel(logging.INFO)
    log.addHandler(handler)
    try:
        yield
    finally:
        log.removeHandler(handler)
        handler.close()


def _write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _transcript_text(speech_segments) -> str:
    return "\n".join(
        f"[{round(segment.start * 1000)}-{round(segment.end * 1000)}] {segment.text.strip()}"
        for segment in speech_segments
        if segment.text.strip()
    )


def _dialogue_context(
    speech_segments,
    gap,
    program_context: dict,
    prior_narrations: list[str],
) -> str:
    """현재 gap 전후 대사와 전체 영상에서 검증한 인물 사전을 구조화해 전달한다."""
    before = [
        segment
        for segment in speech_segments
        if round(segment.end * 1000) <= gap.start_ms and segment.text.strip()
    ][-config.DESCRIBE_CONTEXT_BEFORE_SEGMENTS :]
    after = [
        segment
        for segment in speech_segments
        if round(segment.start * 1000) >= gap.end_ms and segment.text.strip()
    ][: config.DESCRIBE_CONTEXT_AFTER_SEGMENTS]

    def serialize(segment):
        return {
            "start_ms": round(segment.start * 1000),
            "end_ms": round(segment.end * 1000),
            "text": segment.text.strip(),
        }

    return json.dumps(
        {
            "current_gap": {"start_ms": gap.start_ms, "end_ms": gap.end_ms},
            "program_context": program_context,
            "dialogue_before": [serialize(segment) for segment in before],
            "dialogue_after_reference_only": [serialize(segment) for segment in after],
            "prior_narrations": prior_narrations[-5:],
        },
        ensure_ascii=False,
    )


def _shrink_and_resynthesize(
    adapter: ModelAdapter, frame_paths, context: Optional[str], gap_dur_ms: int, max_chars: int
):
    """구간을 넘긴 통합 해설을 더 짧게 다시 쓰고 TTS 길이를 재확인한다.

    화면 글자도 VLM이 문맥 속에서 자연스러운 해설로 통합한 뒤의 결과이므로, 원문
    OCR을 잘라 붙이지 않고 모델에 같은 근거 화면과 문맥을 다시 주어 의미를 보존한다.
    """
    describe_candidates = _pick_frames(frame_paths, config.MAX_DESCRIBE_FRAMES_PER_GAP)
    shortened = max_chars
    attempts = []
    for _ in range(config.DESCRIBE_MAX_RETRIES):
        shortened = max(round(shortened * config.SHORTEN_MAX_CHARS_RATIO), 1)
        result = adapter.describe(describe_candidates, context, shortened)
        text = result.text.strip()
        if (
            not result.should_narrate
            or not text
            or len(text) > shortened
            or result.confidence != "high"
        ):
            attempts.append(
                {
                    "text": text,
                    "confidence": result.confidence,
                    "max_chars": shortened,
                    "rejected_reason": result.reason or "text_invalid",
                }
            )
            continue
        wav_bytes, duration_ms = tts.synthesize(adapter, text)
        if duration_ms <= gap_dur_ms:
            attempts.append({"text": text, "confidence": result.confidence, "max_chars": shortened, "rejected_reason": None})
            return text, wav_bytes, duration_ms, attempts
        attempts.append({"text": text, "confidence": result.confidence, "max_chars": shortened, "rejected_reason": "still_too_long"})
    return None, None, None, attempts


def run_pipeline(
    provider: str,
    video_id: str,
    video_path: str,
    repository: FileRepository,
    adapter: ModelAdapter,
    *,
    language: str = "ko",
    srt_path: Optional[str] = None,
    runs_dir: Optional[Path] = None,
    progress_callback: Optional[Callable[[str, int], None]] = None,
) -> dict:
    def progress(stage: str, percent: int) -> None:
        if progress_callback is not None:
            progress_callback(stage, percent)

    # revision 은 catalog 상태와 무관하므로 먼저 정해서 run 디렉터리부터 만든다 —
    # 그래야 오디오를 한 번만 추출해서 그 자리에 바로 영구 보관할 수 있다.
    revision = repository.next_revision(provider, video_id)
    run_dir = Path(runs_dir or config.PIPELINE_RUNS_DIR) / provider / video_id / f"r{revision}"
    run_dir.mkdir(parents=True, exist_ok=True)

    with _run_log_file(run_dir / "pipeline.log"):
        log.info("실행 디렉터리: %s", run_dir)
        progress("media_preparation", 5)

        audio_path = str(run_dir / "audio.wav")
        media.extract_audio(video_path, audio_path)
        duration_ms = media.audio_duration_ms(audio_path)
        progress("media_preparation", 15)

        # 장애인이든 비장애인이든 영상을 한 편씩 통째로 본다 — 미리 catalog.json을
        # 손으로 채워 둬야만 처리할 수 있는 건 이 도구의 목적과 맞지 않는다.
        # 처음 보는 video_id는 실측 길이로 그 자리에서 등록하고 바로 처리한다.
        video = repository.get_catalog_video(provider, video_id)
        if video is None:
            video = repository.upsert_catalog_video(provider, video_id, duration_ms)
            log.info("카탈로그에 새로 등록: %s:%s (%dms)", provider, video_id, duration_ms)
        elif abs(duration_ms - video.duration_ms) > DURATION_TOLERANCE_MS:
            # 아직 게시된 manifest가 없다면 catalog 길이는 브라우저가 최초 작업을
            # 시작할 때 보낸 힌트일 뿐이다. YouTube SPA/재생목록 전환 중에는 이전
            # 영상의 duration이 잠시 남을 수 있으므로 다운로드 후 ffmpeg로 잰 값을
            # 최종 기준으로 승격한다. 이미 게시된 manifest가 있는 영상은 동기화
            # 안전을 위해 기존처럼 다른 미디어로 간주한다.
            existing_manifest = repository.find_manifest(provider, video_id, video)
            if existing_manifest is None:
                log.warning(
                    "게시 전 catalog 길이를 실측값으로 교정: 등록 %dms -> 실측 %dms",
                    video.duration_ms,
                    duration_ms,
                )
                video = repository.upsert_catalog_video(provider, video_id, duration_ms)
            else:
                log.error(
                    "영상 길이가 catalog 등록값과 %dms 넘게 다릅니다: 실측 %dms, 등록 %dms",
                    DURATION_TOLERANCE_MS, duration_ms, video.duration_ms,
                )
                raise PipelineError(
                    f"영상 길이가 catalog 등록값과 {DURATION_TOLERANCE_MS}ms 넘게 다릅니다: "
                    f"실측 {duration_ms}ms, 등록 {video.duration_ms}ms"
                )

        log.info("M2: 전사 및 무음 구간 산출 시작")
        progress("audio_analysis", 20)
        transcript = adapter.transcribe(audio_path, language=language)
        gaps = build_gaps(transcript, duration_ms)
        log.info("M2: gap %d개 확정", len(gaps))
        progress("audio_analysis", 35)

        speech_log = [
            {"start_ms": round(s.start * 1000), "end_ms": round(s.end * 1000), "text": s.text}
            for s in transcript.segments
        ]
        _write_json(
            run_dir / "segments.json",
            {
                "duration_ms": duration_ms,
                "speech": speech_log,
                "gaps": [{"start_ms": g.start_ms, "end_ms": g.end_ms, "max_chars": g.max_chars} for g in gaps],
            },
        )

        frames_dir = str(run_dir / "frames")
        progress("visual_analysis", 40)
        overview_paths = media.capture_overview_frames(
            video_path, duration_ms, str(run_dir / "overview_frames")
        )
        program_context: dict = {
            "summary": "",
            "people": [],
            "locations": [],
            "important_terms": [],
            "recurring_branding": [],
        }
        analyze_program = getattr(adapter, "analyze_program", None)
        if callable(analyze_program):
            try:
                analyzed = analyze_program(_transcript_text(transcript.segments), overview_paths)
                if isinstance(analyzed, dict):
                    program_context.update(analyzed)
                log.info(
                    "M3: 전체 문맥 분석 완료 — 인물 %d명, 반복 브랜딩 %d개",
                    len(program_context.get("people", [])),
                    len(program_context.get("recurring_branding", [])),
                )
            except Exception as exc:  # noqa: BLE001 - gap별 분석은 계속 수행한다
                log.warning("M3: 전체 문맥 분석 실패, 지역 문맥으로 계속합니다: %s", exc)
                program_context["analysis_error"] = str(exc)
        _write_json(run_dir / "program_context.json", program_context)

        frames_by_gap = media.capture_gap_frames(video_path, gaps, frames_dir)

        # 초당 3장 캡처는 그대로 두고, API에 보내기 직전에 거의 같은 연속 화면만
        # 로컬에서 제거한다. 각 유사 묶음의 마지막 장을 남겨 점진적으로 완성되는
        # 자막이 초반의 불완전한 상태로 OCR되는 문제도 줄인다.
        frame_selection_log = []
        selected_frames_by_gap = {}
        total_captured = 0
        total_selected = 0
        for gap_index, captured in frames_by_gap.items():
            selected, decisions = media.filter_similar_frames(captured)
            selected_frames_by_gap[gap_index] = selected
            total_captured += len(captured)
            total_selected += len(selected)
            frame_selection_log.append(
                {
                    "gap_index": gap_index,
                    "captured_count": len(captured),
                    "selected_count": len(selected),
                    "removed_count": len(captured) - len(selected),
                    "threshold": config.FRAME_SIMILARITY_THRESHOLD,
                    "selected_frames": selected,
                    "decisions": decisions,
                }
            )
        _write_json(run_dir / "frame_selection.json", frame_selection_log)
        log.info(
            "M1: 프레임 유사도 정리 완료 — 캡처 %d장, API 후보 %d장, 제거 %d장",
            total_captured,
            total_selected,
            total_captured - total_selected,
        )
        progress("visual_analysis", 50)

        segments = []
        script_log = []
        ocr_log = []
        prior_segment_texts: list[str] = []
        last_extended_trigger_ms = -config.PLAYBACK_MIN_EXTENDED_INTERVAL_MS
        skipped = 0
        progress("description_generation", 55)

        for index, gap in enumerate(gaps):
            frame_paths = selected_frames_by_gap.get(index, [])
            context = _dialogue_context(
                transcript.segments, gap, program_context, prior_segment_texts
            )
            speech_texts = [
                segment.text.strip()
                for segment in transcript.segments
                if round(segment.end * 1000) <= gap.end_ms and segment.text.strip()
            ]
            candidate_max_chars = max(gap.max_chars, config.EXTENDED_MAX_CHARS)

            decision, trace = decide(
                frame_paths,
                candidate_max_chars,
                speech_texts,
                context,
                prior_segment_texts,
                adapter,
            )
            for attempt in trace.ocr_attempts:
                ocr_log.append({"gap_index": index, **dataclasses.asdict(attempt)})

            entry = {
                "gap_index": index,
                "start_ms": gap.start_ms,
                "end_ms": gap.end_ms,
                "max_chars": gap.max_chars,
                "candidate_max_chars": candidate_max_chars,
                "describe_attempts": [dataclasses.asdict(a) for a in trace.describe_attempts],
            }

            if decision is None:
                log.info("gap[%d] skip (%s)", index, trace.skip_reason)
                entry.update(status="skipped", skip_reason=trace.skip_reason)
                script_log.append(entry)
                skipped += 1
                continue

            log.info(
                "gap[%d] 채택 source=%s len=%d: %s", index, decision.source, len(decision.text), decision.text
            )

            gap_dur_ms = gap.end_ms - gap.start_ms
            wav_bytes, duration_ms_clip = tts.synthesize(adapter, decision.text)
            log.info("gap[%d] TTS %dms (목표 %dms 이하)", index, duration_ms_clip, gap_dur_ms)

            overlay_budget_ms = max(1, gap_dur_ms - config.PLAYBACK_SAFETY_MARGIN_MS)
            mode = "overlay"
            extended_allowed = (
                decision.importance == "high"
                and decision.pause_eligible
                and gap.start_ms - last_extended_trigger_ms
                >= config.PLAYBACK_MIN_EXTENDED_INTERVAL_MS
            )
            if duration_ms_clip > overlay_budget_ms and extended_allowed:
                if duration_ms_clip > config.PLAYBACK_MAX_EXTENDED_DURATION_MS:
                    log.info("gap[%d] extended 8초 예산 초과 -> 핵심 위주 축약", index)
                    (
                        shortened_text,
                        shortened_wav,
                        shortened_duration_ms,
                        shrink_attempts,
                    ) = _shrink_and_resynthesize(
                        adapter,
                        frame_paths,
                        context,
                        config.PLAYBACK_MAX_EXTENDED_DURATION_MS,
                        candidate_max_chars,
                    )
                    entry["describe_attempts"].extend(shrink_attempts)
                    if shortened_text is not None:
                        decision.text = shortened_text
                        wav_bytes = shortened_wav
                        duration_ms_clip = shortened_duration_ms
                if (
                    duration_ms_clip > overlay_budget_ms
                    and duration_ms_clip <= config.PLAYBACK_MAX_EXTENDED_DURATION_MS
                ):
                    mode = "extended"
                    last_extended_trigger_ms = gap.start_ms
                    log.info("gap[%d] extended 채택 (%dms)", index, duration_ms_clip)

            if duration_ms_clip > overlay_budget_ms and mode == "overlay":
                log.info("gap[%d] overlay 예산 초과 -> 문맥을 보존해 축약", index)
                text, wav_bytes, duration_ms_clip, shrink_attempts = _shrink_and_resynthesize(
                    adapter, frame_paths, context, overlay_budget_ms, gap.max_chars
                )
                entry["describe_attempts"].extend(shrink_attempts)
                if text is None:
                    log.info("gap[%d] skip (tts_overflow_unshrinkable)", index)
                    entry.update(
                        status="skipped",
                        skip_reason="tts_overflow_unshrinkable",
                        source=decision.source,
                    )
                    script_log.append(entry)
                    skipped += 1
                    continue
                decision.text = text

            clip_hash = repository.publish_audio(wav_bytes)
            prior_segment_texts.append(decision.text)
            segment_id = f"seg-{len(segments) + 1:03d}"
            segments.append(
                {
                    "id": segment_id,
                    "mode": mode,
                    "trigger_ms": gap.start_ms,
                    "text": decision.text,
                    "importance": decision.importance,
                    "source": decision.source,
                    "confidence": "high",
                    "audio": {
                        "path": f"/v1/audio/{clip_hash}.wav",
                        "duration_ms": duration_ms_clip,
                        "sha256": clip_hash,
                    },
                }
            )
            if mode == "overlay":
                segments[-1]["deadline_ms"] = gap.end_ms
            entry.update(
                status="published",
                segment_id=segment_id,
                source=decision.source,
                confidence=decision.confidence,
                text=decision.text,
                audio_duration_ms=duration_ms_clip,
                mode=mode,
                importance=decision.importance,
            )
            script_log.append(entry)

            if gaps:
                progress("description_generation", min(85, 55 + round((index + 1) * 30 / len(gaps))))

        _write_json(run_dir / "ocr.json", ocr_log)
        _write_json(run_dir / "script.json", script_log)
        progress("speech_synthesis", 90)

        manifest = {
            "schema_version": "1.1",
            "manifest_id": f"{provider}:{video_id}:r{revision}",
            "revision": revision,
            "video": {
                "provider": provider,
                "video_id": video_id,
                "duration_ms": duration_ms,
            },
            "voice": {
                "voice_id": config.MANIFEST_VOICE_ID,
                "format": "audio/wav",
                "sample_rate_hz": config.MANIFEST_SAMPLE_RATE_HZ,
            },
            "playback": {
                "duck_factor": config.PLAYBACK_DUCK_FACTOR,
                "preload_count": config.PLAYBACK_PRELOAD_COUNT,
                "lookahead_ms": config.PLAYBACK_LOOKAHEAD_MS,
                "late_tolerance_ms": config.PLAYBACK_LATE_TOLERANCE_MS,
                "auto_pause_default": config.PLAYBACK_AUTO_PAUSE_DEFAULT,
                "max_extended_duration_ms": config.PLAYBACK_MAX_EXTENDED_DURATION_MS,
                "min_extended_interval_ms": config.PLAYBACK_MIN_EXTENDED_INTERVAL_MS,
            },
            "segments": segments,
        }

        progress("validation", 95)
        record = repository.publish_manifest(manifest)
        log.info("게시 완료: %s (%d/%d 게시)", record.data["manifest_id"], len(segments), len(gaps))

        if srt_path:
            srt_text = build_srt(speech_log, segments)
            Path(srt_path).parent.mkdir(parents=True, exist_ok=True)
            Path(srt_path).write_text(srt_text, encoding="utf-8")

        return {
            "manifest": record.data,
            "gaps_total": len(gaps),
            "segments_published": len(segments),
            "segments_skipped": skipped,
            "frames_captured": total_captured,
            "frames_selected": total_selected,
            "frames_removed": total_captured - total_selected,
            "run_dir": str(run_dir),
        }


def _parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", required=True)
    parser.add_argument("--video-id", required=True)
    parser.add_argument(
        "--video",
        help="로컬 영상 파일 경로. provider가 youtube이고 생략하면 video_id로 자동 다운로드한다",
    )
    parser.add_argument("--language", default="ko")
    parser.add_argument(
        "--srt-out", help="원본 대사 + 화면해설을 합친 검수용 SRT를 이 경로에 저장한다 (선택)"
    )
    parser.add_argument(
        "--runs-dir", help="중간 산출물(오디오/프레임/segments·ocr·script.json/로그) 저장 위치 (기본: config.PIPELINE_RUNS_DIR)"
    )
    return parser.parse_args(argv)


def main(argv=None) -> int:
    # Windows 콘솔 코드페이지(cp949 등)가 이 파일의 한글/em dash 를 인코딩하지
    # 못해 --help 나 오류 메시지 출력 자체가 죽는 것을 막는다. CLI로 실행될
    # 때만 적용한다 — 이 모듈을 라이브러리로 import 하는 Flask 프로세스의
    # stdout 인코딩까지 건드리면 안 된다.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    args = _parse_args(argv)

    repository = FileRepository(config.DATA_DIR, config.DATABASE_PATH)
    try:
        adapter = OpenAIAdapter()
    except RuntimeError as exc:
        print(f"어댑터 초기화 실패: {exc}", file=sys.stderr)
        return 1

    video_path = args.video
    downloaded_dir: Optional[tempfile.TemporaryDirectory] = None
    if video_path is None:
        if args.provider != "youtube":
            print("--video 없이 자동 다운로드는 provider=youtube 에서만 지원합니다", file=sys.stderr)
            return 1
        downloaded_dir = tempfile.TemporaryDirectory(prefix="soundbridge_youtube_")
        target = str(Path(downloaded_dir.name) / f"{args.video_id}.mp4")
        log.info("M1: 유튜브에서 mp4로 다운로드 시작 (video_id=%s)", args.video_id)
        try:
            video_path = download_youtube(args.video_id, target)
        except Exception as exc:  # noqa: BLE001 - yt-dlp 예외를 하나의 실패 메시지로 정리한다
            print(f"유튜브 다운로드 실패: {exc}", file=sys.stderr)
            downloaded_dir.cleanup()
            return 1

    try:
        result = run_pipeline(
            args.provider,
            args.video_id,
            video_path,
            repository,
            adapter,
            language=args.language,
            srt_path=args.srt_out,
            runs_dir=Path(args.runs_dir) if args.runs_dir else None,
        )
    except (PipelineError, CatalogInvalid, ManifestInvalid, ContractValidationError) as exc:
        print(f"파이프라인 실패: {exc}", file=sys.stderr)
        return 1
    finally:
        if downloaded_dir is not None:
            downloaded_dir.cleanup()

    print(
        f"게시 완료: {result['manifest']['manifest_id']} "
        f"(gap {result['gaps_total']}개 중 {result['segments_published']}개 게시, "
        f"{result['segments_skipped']}개 skip)"
    )
    print(f"중간 산출물·로그: {result['run_dir']}")
    if args.srt_out:
        print(f"검수용 SRT 저장: {args.srt_out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
