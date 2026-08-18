"use strict";

const API_ORIGIN = "http://127.0.0.1:5000";
const AUDIO_PATH_RE = /^\/v1\/audio\/([a-f0-9]{64})\.wav$/;
const SEGMENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_DECODED_CLIPS = 20;

let audioContext = null;
let currentPlayback = null;
const decodedClips = new Map();

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function engineError(code, message, segmentId = null) {
  const error = new Error(message);
  error.code = code;
  error.segmentId = segmentId;
  return error;
}

function validateClipMessage(message) {
  if (typeof message.video_key !== "string" || !message.video_key) {
    throw engineError("INVALID_VIDEO_KEY", "video_key가 없습니다.", message.segment_id);
  }
  if (!Number.isInteger(message.revision) || message.revision < 1) {
    throw engineError("INVALID_REVISION", "revision이 올바르지 않습니다.", message.segment_id);
  }
  if (typeof message.segment_id !== "string" || !SEGMENT_ID_RE.test(message.segment_id)) {
    throw engineError("INVALID_SEGMENT", "segment_id가 올바르지 않습니다.", message.segment_id);
  }
  if (typeof message.sha256 !== "string" || !SHA256_RE.test(message.sha256)) {
    throw engineError("INVALID_SHA256", "sha256이 올바르지 않습니다.", message.segment_id);
  }
  if (!Number.isInteger(message.duration_ms) || message.duration_ms <= 0) {
    throw engineError("INVALID_DURATION", "duration_ms가 올바르지 않습니다.", message.segment_id);
  }

  let url;
  try {
    url = new URL(message.audio_url);
  } catch (_error) {
    throw engineError("INVALID_AUDIO_URL", "audio_url이 URL이 아닙니다.", message.segment_id);
  }
  const pathMatch = url.pathname.match(AUDIO_PATH_RE);
  if (
    url.origin !== API_ORIGIN ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !pathMatch ||
    pathMatch[1] !== message.sha256
  ) {
    throw engineError("UNTRUSTED_AUDIO_URL", "고정 API origin의 sha256 오디오 경로만 허용됩니다.", message.segment_id);
  }

  return {
    video_key: message.video_key,
    revision: message.revision,
    segment_id: message.segment_id,
    sha256: message.sha256.toLowerCase(),
    duration_ms: message.duration_ms,
    audio_url: `${API_ORIGIN}/v1/audio/${message.sha256.toLowerCase()}.wav`,
  };
}

function ensureAudioContext() {
  if (!audioContext || audioContext.state === "closed") audioContext = new AudioContext({ latencyHint: "interactive" });
  return audioContext;
}

function bytesToHex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function touchClip(sha256, clip) {
  decodedClips.delete(sha256);
  decodedClips.set(sha256, clip);
  while (decodedClips.size > MAX_DECODED_CLIPS) {
    const oldestKey = decodedClips.keys().next().value;
    if (currentPlayback && currentPlayback.clip.sha256 === oldestKey) {
      const current = decodedClips.get(oldestKey);
      decodedClips.delete(oldestKey);
      decodedClips.set(oldestKey, current);
      continue;
    }
    decodedClips.delete(oldestKey);
  }
}

async function loadClip(message) {
  const trusted = validateClipMessage(message);
  const cached = decodedClips.get(trusted.sha256);
  if (cached) {
    touchClip(trusted.sha256, cached);
    return { ...cached, segment_id: trusted.segment_id, video_key: trusted.video_key, revision: trusted.revision };
  }

  let response;
  try {
    response = await fetch(trusted.audio_url, {
      cache: "force-cache",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
  } catch (error) {
    throw engineError("AUDIO_FETCH_FAILED", `오디오 다운로드 실패: ${errorMessage(error)}`, trusted.segment_id);
  }
  if (!response.ok) {
    throw engineError("AUDIO_FETCH_FAILED", `오디오 다운로드 실패 (HTTP ${response.status})`, trusted.segment_id);
  }
  const contentLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_AUDIO_BYTES) {
    throw engineError("AUDIO_TOO_LARGE", "오디오 파일이 허용 크기를 초과합니다.", trusted.segment_id);
  }
  const contentType = (response.headers.get("Content-Type") || "").toLowerCase();
  if (contentType && !contentType.includes("audio/wav") && !contentType.includes("audio/x-wav") && !contentType.includes("application/octet-stream")) {
    throw engineError("INVALID_AUDIO_TYPE", `지원하지 않는 Content-Type: ${contentType}`, trusted.segment_id);
  }

  const bytes = await response.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > MAX_AUDIO_BYTES) {
    throw engineError("AUDIO_TOO_LARGE", "오디오 파일 크기가 올바르지 않습니다.", trusted.segment_id);
  }
  const digest = bytesToHex(await crypto.subtle.digest("SHA-256", bytes));
  if (digest !== trusted.sha256) {
    throw engineError("AUDIO_HASH_MISMATCH", "오디오 sha256 검증에 실패했습니다.", trusted.segment_id);
  }

  let buffer;
  try {
    buffer = await ensureAudioContext().decodeAudioData(bytes.slice(0));
  } catch (error) {
    throw engineError("AUDIO_DECODE_FAILED", `오디오 디코딩 실패: ${errorMessage(error)}`, trusted.segment_id);
  }
  const decodedDurationMs = Math.round(buffer.duration * 1000);
  if (Math.abs(decodedDurationMs - trusted.duration_ms) > 1000) {
    throw engineError("AUDIO_DURATION_MISMATCH", "매니페스트와 실제 오디오 duration이 다릅니다.", trusted.segment_id);
  }

  const clip = {
    sha256: trusted.sha256,
    audio_url: trusted.audio_url,
    duration_ms: trusted.duration_ms,
    buffer,
  };
  touchClip(trusted.sha256, clip);
  return { ...clip, segment_id: trusted.segment_id, video_key: trusted.video_key, revision: trusted.revision };
}

function sendEngineState(payload) {
  chrome.runtime.sendMessage({ type: "ENGINE_STATE", ...payload }).catch(() => {});
}

function stopPlayback(reason, emitState = true) {
  const playback = currentPlayback;
  if (!playback) return null;
  currentPlayback = null;
  playback.suppressed = true;
  if (playback.startedTimer) clearTimeout(playback.startedTimer);
  playback.source.onended = null;
  try {
    playback.source.stop();
  } catch (_error) {
    // 이미 자연 종료된 source는 다시 stop할 수 없다.
  }
  if (emitState) {
    sendEngineState({
      segment_id: playback.segment_id,
      state: "stopped",
      offset_ms: playbackOffsetMs(playback),
      reason,
    });
  }
  return playback;
}

function playbackOffsetMs(playback) {
  const context = audioContext;
  if (!context) return playback.offset_ms;
  const elapsedContextSeconds = Math.max(0, context.currentTime - playback.start_context_time);
  const elapsedBufferMs = elapsedContextSeconds * playback.playback_rate * 1000;
  return Math.round(clamp(playback.offset_ms + elapsedBufferMs, 0, playback.clip.buffer.duration * 1000));
}

async function playClip(message, offsetMs = 0, requestedDelayMs = 0) {
  const receivedAt = performance.now();
  const clip = await loadClip(message);
  const context = ensureAudioContext();
  try {
    await context.resume();
  } catch (error) {
    throw engineError("AUDIO_CONTEXT_BLOCKED", `AudioContext를 시작할 수 없습니다: ${errorMessage(error)}`, clip.segment_id);
  }

  stopPlayback("replaced", true);
  const playbackRate = Number.isFinite(message.playback_rate) ? clamp(message.playback_rate, 0.25, 4) : 1;
  const safeOffsetMs = clamp(Math.round(offsetMs), 0, Math.max(0, clip.buffer.duration * 1000 - 1));
  const elapsedLoadMs = performance.now() - receivedAt;
  const delayMs = Math.max(0, Math.round(requestedDelayMs - elapsedLoadMs));
  const source = context.createBufferSource();
  source.buffer = clip.buffer;
  source.playbackRate.value = playbackRate;
  source.connect(context.destination);
  const startContextTime = context.currentTime + delayMs / 1000;

  const playback = {
    source,
    clip,
    segment_id: clip.segment_id,
    video_key: clip.video_key,
    revision: clip.revision,
    offset_ms: safeOffsetMs,
    playback_rate: playbackRate,
    start_context_time: startContextTime,
    startedTimer: null,
    suppressed: false,
  };
  currentPlayback = playback;
  source.onended = () => {
    if (playback.suppressed || currentPlayback !== playback) return;
    if (playback.startedTimer) clearTimeout(playback.startedTimer);
    currentPlayback = null;
    sendEngineState({ segment_id: playback.segment_id, state: "ended", offset_ms: playback.clip.duration_ms });
  };
  try {
    source.start(startContextTime, safeOffsetMs / 1000);
  } catch (error) {
    currentPlayback = null;
    throw engineError("AUDIO_START_FAILED", `오디오 source 시작 실패: ${errorMessage(error)}`, clip.segment_id);
  }
  playback.startedTimer = setTimeout(() => {
    if (currentPlayback !== playback || playback.suppressed) return;
    sendEngineState({ segment_id: playback.segment_id, state: "started", offset_ms: safeOffsetMs });
  }, delayMs);

  return { type: "STARTED", segment_id: clip.segment_id, delay_ms: delayMs, offset_ms: safeOffsetMs };
}

async function handleClipLoad(message) {
  const clip = await loadClip(message);
  sendEngineState({ segment_id: clip.segment_id, state: "ready", offset_ms: 0 });
  return { type: "READY", segment_id: clip.segment_id };
}

async function handlePlay(message) {
  const delayMs = Number.isFinite(message.delay_ms) ? clamp(Math.round(message.delay_ms), 0, 10000) : 0;
  return playClip(message, 0, delayMs);
}

async function handlePause(message) {
  const playback = currentPlayback;
  if (!playback || playback.segment_id !== message.segment_id) {
    throw engineError("SEGMENT_NOT_PLAYING", "요청한 segment가 재생 중이 아닙니다.", message.segment_id);
  }
  const offsetMs = playbackOffsetMs(playback);
  stopPlayback("pause", false);
  sendEngineState({ segment_id: playback.segment_id, state: "paused", offset_ms: offsetMs });
  return { type: "PAUSED", segment_id: playback.segment_id, offset_ms: offsetMs };
}

async function handleResume(message) {
  const offsetMs = Number.isFinite(message.offset_ms) ? Math.max(0, Math.round(message.offset_ms)) : 0;
  return playClip(message, offsetMs, 0);
}

async function handleStop(message) {
  const stopped = stopPlayback(String(message.reason || "stop"), true);
  const reason = String(message.reason || "stop");
  if (["disable", "navigation", "video-replace", "active-tab-changed", "tab-closed", "cleanup"].includes(reason)) {
    decodedClips.clear();
  }
  if (audioContext && audioContext.state === "running") audioContext.suspend().catch(() => {});
  return { type: "STOPPED", segment_id: stopped ? stopped.segment_id : null, reason };
}

const HANDLERS = {
  CLIP_LOAD: handleClipLoad,
  PLAY: handlePlay,
  PAUSE: handlePause,
  RESUME: handleResume,
  STOP: handleStop,
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return undefined;
  const handler = HANDLERS[message.type];
  if (!handler) return undefined;
  Promise.resolve(handler(message))
    .then((response) => sendResponse(response))
    .catch((error) => {
      const code = error.code || "AUDIO_ENGINE_ERROR";
      const segmentId = error.segmentId || message.segment_id || null;
      sendEngineState({
        segment_id: segmentId,
        state: "error",
        operation: message.type,
        offset_ms: 0,
        error_code: code,
        message: errorMessage(error),
      });
      sendResponse({
        type: "ERROR",
        request_id: message.request_id || null,
        segment_id: segmentId,
        error: { code, message: errorMessage(error), retryable: code === "AUDIO_FETCH_FAILED" },
      });
    });
  return true;
});
