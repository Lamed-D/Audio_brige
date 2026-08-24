import logging
import tempfile
from pathlib import Path

from flask import Flask, jsonify, request, send_file
from flask_cors import CORS

import config
from api.dev import register_dev
from api.v1 import register_v1
from adapters.openai_adapter import OpenAIAdapter
from core import narrator
from core.audio_stream import decode_webm_chunk, rms_db_windows
from core.session import registry
from core.storage import FileRepository

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = config.MAX_REQUEST_BYTES

cors_resources = {r"/v1/*": {"origins": config.CORS_ALLOWED_ORIGINS}}
if config.LEGACY_SESSION_API_ENABLED:
    cors_resources.update(
        {
            r"/session/*": {"origins": config.CORS_ALLOWED_ORIGINS},
            r"/": {"origins": config.CORS_ALLOWED_ORIGINS},
        }
    )
if config.DEV_PIPELINE_API_ENABLED:
    cors_resources[r"/dev/*"] = {"origins": config.CORS_ALLOWED_ORIGINS}
CORS(app, resources=cors_resources)

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("soundbridge")

v1_repository = FileRepository(config.DATA_DIR)
register_v1(app, v1_repository)

_adapter = None
_adapter_error = None


def get_adapter():
    global _adapter, _adapter_error
    if _adapter is None and _adapter_error is None:
        try:
            _adapter = OpenAIAdapter()
        except RuntimeError as e:
            _adapter_error = str(e)
    return _adapter, _adapter_error


if config.DEV_PIPELINE_API_ENABLED:
    register_dev(app, v1_repository, get_adapter)
    log.warning(
        "/dev/process 활성화됨 — 실제 유튜브 다운로드와 과금 API를 호출합니다. "
        "127.0.0.1 밖으로 노출하지 마세요 (VOICE_BRIDGE_ENABLE_DEV_PIPELINE_API=false 로 끌 수 있습니다)"
    )


@app.before_request
def reject_disabled_legacy_session_api():
    if request.path.startswith("/session/") and not config.LEGACY_SESSION_API_ENABLED:
        return jsonify({"error": "legacy session API is disabled"}), 404


@app.get("/")
def health():
    adapter, err = get_adapter()
    return jsonify({"status": "ok", "adapter_ready": adapter is not None, "adapter_error": err})


@app.post("/session/start")
def session_start():
    body = request.get_json(silent=True) or {}
    mode = body.get("mode")
    if mode not in (None, "text", "tts"):
        return jsonify({"error": "mode 는 text 또는 tts 여야 합니다"}), 400
    s = registry.create(mode=mode)
    return jsonify({"session_id": s.id, "mode": s.mode})


@app.post("/session/<sid>/stop")
def session_stop(sid):
    registry.remove(sid)
    return jsonify({"ok": True})


@app.post("/session/<sid>/frame")
def session_frame(sid):
    session = registry.get(sid)
    if session is None:
        return jsonify({"error": "unknown session"}), 404
    session.touch()

    file = request.files.get("file")
    video_time = request.form.get("video_time", type=float)
    if file is None or video_time is None:
        return jsonify({"error": "file, video_time 가 필요합니다"}), 400

    path = session.add_frame(video_time, file.read())

    resp = {"ok": True}
    # 무음 구간이 아직 안 끝나서 narrate 파이프라인을 안 타더라도, 프레임이 실제로 뭘
    # 읽고 있는지 즉시 확인할 수 있게 하는 디버그 옵션 (M3 OCR 을 gap 확정 없이 바로 실행).
    if request.form.get("debug_ocr") in ("1", "true", "True"):
        adapter, adapter_error = get_adapter()
        if adapter is None:
            resp["debug_error"] = adapter_error
        else:
            try:
                result = adapter.read_text(path)
                resp["debug_text"] = result.text
                resp["debug_confidence"] = result.confidence
            except Exception as e:  # noqa: BLE001
                resp["debug_error"] = str(e)

    return jsonify(resp)


@app.post("/session/<sid>/audio")
def session_audio(sid):
    session = registry.get(sid)
    if session is None:
        return jsonify({"error": "unknown session"}), 404
    session.touch()

    file = request.files.get("file")
    video_time = request.form.get("video_time", type=float)
    if file is None or video_time is None:
        return jsonify({"error": "file, video_time 가 필요합니다"}), 400
    raw = file.read()

    try:
        samples, sr = decode_webm_chunk(raw)
    except ValueError as e:
        log.warning("decode failed: %s", e)
        return jsonify({"error": str(e)}), 400

    windows = rms_db_windows(samples, sr, video_time)
    has_speech = any(db >= config.SILENCE_DB for _, db in windows)
    avg_db = round(sum(db for _, db in windows) / len(windows), 1) if windows else None

    adapter, adapter_error = get_adapter()

    if has_speech and adapter is not None:
        with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
            tmp.write(raw)
            tmp_path = tmp.name
        try:
            result = adapter.transcribe(tmp_path)
            for seg in result.segments:
                session.add_speech(seg.start + video_time, seg.end + video_time, seg.text)
        except Exception as e:  # noqa: BLE001 - STT 실패로 전체 파이프라인이 죽으면 안 된다
            log.warning("transcribe failed: %s", e)
        finally:
            Path(tmp_path).unlink(missing_ok=True)

    finalized = []
    with session.lock:
        for t, db in windows:
            is_silent = db < config.SILENCE_DB
            finalized.extend(session.gap_detector.push(t, is_silent))

    narrated = 0
    if adapter is not None:
        for gap in finalized:
            try:
                if narrator.process_gap(session, gap, adapter):
                    narrated += 1
            except Exception as e:  # noqa: BLE001
                log.warning("narrate failed for gap %s: %s", gap, e)

    return jsonify({
        "ok": True,
        "gaps_finalized": len(finalized),
        "narrated": narrated,
        "adapter_error": adapter_error,
        "avg_db": avg_db,
        "silence_threshold_db": config.SILENCE_DB,
        "is_silent": not has_speech,
    })


@app.get("/session/<sid>/narrations")
def session_narrations(sid):
    session = registry.get(sid)
    if session is None:
        return jsonify({"error": "unknown session"}), 404
    session.touch()

    items = session.pop_ready()
    for item in items:
        clip_path = item.pop("clip_path")
        item["audio_url"] = f"/session/{sid}/clip/{Path(clip_path).name}" if clip_path else None
    return jsonify({"items": items, "mode": session.mode})


@app.get("/session/<sid>/clip/<filename>")
def session_clip(sid, filename):
    session = registry.get(sid)
    if session is None or "/" in filename or "\\" in filename:
        return jsonify({"error": "not found"}), 404
    path = session.tmp_dir / "clips" / filename
    if not path.is_file():
        return jsonify({"error": "not found"}), 404
    return send_file(path, mimetype="audio/wav")


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=config.BACKEND_PORT, debug=True, threaded=True)
