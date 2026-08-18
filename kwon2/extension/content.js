"use strict";

const PROVIDER = "youtube";
const SCHEMA_VERSION = "1.1";
const MAX_DURATION_DRIFT_MS = 1000;
const DURATION_STABILITY_MS = 1200;
const DURATION_SAMPLE_TOLERANCE_MS = 250;
const METADATA_RETRY_MS = 350;
const LATE_SKIP_MS = 250;
const DEFAULT_DUCK_FACTOR = 0.35;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;
const AUDIO_PATH_RE = /^\/v1\/audio\/([a-f0-9]{64})\.wav$/;
const SEGMENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const CONFIDENCE_VALUES = new Set(["high"]);
const SOURCE_VALUES = new Set(["ocr", "vlm"]);

const state = {
  enabled: false,
  video: null,
  identity: null,
  manifest: null,
  videoKey: null,
  revision: null,
  nextIndex: 0,
  schedulerTimer: null,
  processingTimer: null,
  reconcileTimer: null,
  startWatchdog: null,
  requestId: null,
  generation: 0,
  scheduledSegmentId: null,
  activeSegmentId: null,
  pausedAudio: null,
  resumePromise: null,
  stopPromise: null,
  audioStarted: false,
  preloaded: new Set(),
  duckFactor: DEFAULT_DUCK_FACTOR,
  autoPause: true,
  extendedPause: null,
  suppressPauseEvent: false,
  volume: null,
  durationProbe: null,
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function requestId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

function sendMessage(message) {
  try {
    return chrome.runtime.sendMessage(message);
  } catch (error) {
    return Promise.reject(error);
  }
}

function reportStatus(status, error = null) {
  sendMessage({ type: "CONTENT_STATUS", status, error }).catch(() => {});
}

function extractYouTubeIdentity(rawUrl = location.href) {
  try {
    const url = new URL(rawUrl);
    let videoId = null;
    if (url.hostname === "youtu.be") {
      videoId = url.pathname.split("/").filter(Boolean)[0] || null;
    } else if (url.hostname === "www.youtube.com" || url.hostname === "m.youtube.com" || url.hostname === "youtube.com") {
      if (url.pathname === "/watch") videoId = url.searchParams.get("v");
      if (!videoId) {
        const match = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/?#]+)/);
        if (match) videoId = match[1];
      }
    }
    if (!videoId || !VIDEO_ID_RE.test(videoId)) return null;
    return { provider: PROVIDER, video_id: videoId, video_key: `${PROVIDER}:${videoId}` };
  } catch (_error) {
    return null;
  }
}

function findYouTubeVideo() {
  const preferred = document.querySelector("video.html5-main-video");
  if (preferred) return preferred;
  const videos = [...document.querySelectorAll("video")];
  if (!videos.length) return null;
  return videos.reduce((largest, video) => {
    const area = video.clientWidth * video.clientHeight;
    const largestArea = largest.clientWidth * largest.clientHeight;
    return area > largestArea ? video : largest;
  });
}

function finiteDurationMs(video) {
  if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return null;
  return Math.round(video.duration * 1000);
}

function playerVideoId() {
  const player = document.querySelector("#movie_player");
  if (!player || typeof player.getVideoData !== "function") return null;
  try {
    const data = player.getVideoData();
    return data && typeof data.video_id === "string" ? data.video_id : null;
  } catch (_error) {
    return null;
  }
}

function stableDurationMs(video, identity) {
  if (!video || !identity) return null;
  const player = document.querySelector("#movie_player");
  if (player && player.classList.contains("ad-showing")) return null;

  // YouTube는 재생목록/SPA 전환 때 URL을 먼저 바꾸고 같은 <video>의 이전
  // metadata를 잠시 유지할 수 있다. URL의 ID와 플레이어 내부 ID가 일치하기
  // 전에는 이전 영상의 duration을 새 영상 값으로 등록하지 않는다.
  const internalVideoId = playerVideoId();
  if (internalVideoId && internalVideoId !== identity.video_id) return null;

  const elementDurationMs = finiteDurationMs(video);
  if (!elementDurationMs) return null;
  let durationMs = elementDurationMs;
  if (player && typeof player.getDuration === "function") {
    try {
      const playerDurationMs = Math.round(Number(player.getDuration()) * 1000);
      if (Number.isFinite(playerDurationMs) && playerDurationMs > 0) {
        if (Math.abs(playerDurationMs - elementDurationMs) > MAX_DURATION_DRIFT_MS) return null;
        durationMs = playerDurationMs;
      }
    } catch (_error) {
      // 공개되지 않은 플레이어 함수는 보조 검증일 뿐이므로 video.duration을 쓴다.
    }
  }

  const now = Date.now();
  const probe = state.durationProbe;
  if (
    !probe ||
    probe.videoKey !== identity.video_key ||
    Math.abs(probe.durationMs - durationMs) > DURATION_SAMPLE_TOLERANCE_MS
  ) {
    state.durationProbe = { videoKey: identity.video_key, durationMs, firstSeenAt: now };
    return null;
  }
  probe.durationMs = durationMs;
  return now - probe.firstSeenAt >= DURATION_STABILITY_MS ? durationMs : null;
}

function resetDurationProbe() {
  state.durationProbe = null;
}

function retryAfterMetadataSettles() {
  if (!state.enabled || state.processingTimer) return;
  state.processingTimer = setTimeout(() => {
    state.processingTimer = null;
    void requestManifest();
  }, METADATA_RETRY_MS);
}

function clearTimer(name) {
  if (state[name]) clearTimeout(state[name]);
  state[name] = null;
}

function clearSchedulingTimers() {
  clearTimer("schedulerTimer");
  clearTimer("startWatchdog");
}

function writeVideoVolume(value) {
  if (!state.video || !state.volume) return;
  const target = clamp(value, 0, 1);
  state.volume.internalVolumeWrite = target;
  try {
    state.video.volume = target;
  } catch (_error) {
    state.volume.internalVolumeWrite = null;
    return;
  }
  setTimeout(() => {
    if (state.volume && state.volume.internalVolumeWrite === target) state.volume.internalVolumeWrite = null;
  }, 250);
}

function beginDucking() {
  if (!state.video || state.video.muted || !state.volume) return;
  if (!state.volume.isDucking) {
    state.volume.userVolume = state.video.volume;
    state.volume.isDucking = true;
  }
  writeVideoVolume(state.volume.userVolume * state.duckFactor);
}

function restoreVolume() {
  if (!state.video || !state.volume || !state.volume.isDucking) return;
  const restoreTo = state.volume.userVolume;
  state.volume.isDucking = false;
  writeVideoVolume(restoreTo);
}

function onVolumeChange() {
  if (!state.video || !state.volume) return;
  if (state.video.muted !== state.volume.lastMuted) {
    state.volume.lastMuted = state.video.muted;
    if (state.video.muted) {
      restoreVolume();
      void stopAudio("muted");
      if (state.manifest) state.nextIndex = firstCandidateIndex(Math.round(state.video.currentTime * 1000));
      reportStatus("muted", null);
    } else {
      state.volume.userVolume = state.video.volume;
      if (state.manifest) state.nextIndex = firstCandidateIndex(Math.round(state.video.currentTime * 1000));
      scheduleFromCurrent("unmuted");
    }
    return;
  }
  const current = state.video.volume;
  if (state.volume.internalVolumeWrite !== null && Math.abs(current - state.volume.internalVolumeWrite) < 0.001) {
    state.volume.internalVolumeWrite = null;
    return;
  }
  state.volume.userVolume = current;
  if (state.volume.isDucking) writeVideoVolume(current * state.duckFactor);
}

function initializeVolumeState(video) {
  state.volume = {
    userVolume: video.volume,
    isDucking: false,
    internalVolumeWrite: null,
    lastMuted: video.muted,
  };
}

function attachVideoListeners(video) {
  video.addEventListener("play", onVideoPlay);
  video.addEventListener("playing", onVideoPlaying);
  video.addEventListener("pause", onVideoPause);
  video.addEventListener("waiting", onVideoWaiting);
  video.addEventListener("seeking", onVideoSeeking);
  video.addEventListener("seeked", onVideoSeeked);
  video.addEventListener("ratechange", onVideoRateChange);
  video.addEventListener("ended", onVideoEnded);
  video.addEventListener("loadedmetadata", onVideoMetadata);
  video.addEventListener("durationchange", onVideoMetadata);
  video.addEventListener("emptied", onVideoEmptied);
  video.addEventListener("timeupdate", onVideoTimeUpdate);
  video.addEventListener("volumechange", onVolumeChange);
}

function detachVideoListeners(video) {
  if (!video) return;
  video.removeEventListener("play", onVideoPlay);
  video.removeEventListener("playing", onVideoPlaying);
  video.removeEventListener("pause", onVideoPause);
  video.removeEventListener("waiting", onVideoWaiting);
  video.removeEventListener("seeking", onVideoSeeking);
  video.removeEventListener("seeked", onVideoSeeked);
  video.removeEventListener("ratechange", onVideoRateChange);
  video.removeEventListener("ended", onVideoEnded);
  video.removeEventListener("loadedmetadata", onVideoMetadata);
  video.removeEventListener("durationchange", onVideoMetadata);
  video.removeEventListener("emptied", onVideoEmptied);
  video.removeEventListener("timeupdate", onVideoTimeUpdate);
  video.removeEventListener("volumechange", onVolumeChange);
}

function assertInteger(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label}는 ${min} 이상 정수여야 합니다.`);
  return value;
}

function validateManifest(raw, expected) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("매니페스트가 객체가 아닙니다.");
  if (raw.schema_version !== SCHEMA_VERSION) throw new Error("지원하지 않는 schema_version입니다.");
  if (typeof raw.manifest_id !== "string" || !raw.manifest_id) throw new Error("manifest_id가 없습니다.");
  assertInteger(raw.revision, "revision", 1);

  if (!raw.video || raw.video.provider !== expected.provider || raw.video.video_id !== expected.video_id) {
    throw new Error("매니페스트의 영상 식별자가 현재 영상과 다릅니다.");
  }
  if (raw.manifest_id !== `${expected.provider}:${expected.video_id}:r${raw.revision}`) {
    throw new Error("manifest_id가 현재 provider/video_id와 일치하지 않습니다.");
  }
  assertInteger(raw.video.duration_ms, "video.duration_ms", 1);
  if (Math.abs(raw.video.duration_ms - expected.duration_ms) > MAX_DURATION_DRIFT_MS) {
    throw new Error("현재 영상과 매니페스트 duration 차이가 1000ms를 초과합니다.");
  }

  const playback = raw.playback;
  if (!playback || typeof playback !== "object") throw new Error("playback 설정이 없습니다.");
  if (!Number.isFinite(playback.duck_factor) || playback.duck_factor < 0.1 || playback.duck_factor > 1) {
    throw new Error("playback.duck_factor 범위가 올바르지 않습니다.");
  }
  assertInteger(playback.preload_count, "playback.preload_count", 0, 10);
  assertInteger(playback.lookahead_ms, "playback.lookahead_ms", 0, 10000);
  assertInteger(playback.late_tolerance_ms, "playback.late_tolerance_ms", 0, 5000);
  if (typeof playback.auto_pause_default !== "boolean") throw new Error("playback.auto_pause_default가 없습니다.");
  assertInteger(playback.max_extended_duration_ms, "playback.max_extended_duration_ms", 1, 8000);
  assertInteger(playback.min_extended_interval_ms, "playback.min_extended_interval_ms", 0);
  if (!Array.isArray(raw.segments)) throw new Error("segments가 배열이 아닙니다.");

  const ids = new Set();
  let previousTrigger = -1;
  let previousExtended = -playback.min_extended_interval_ms;
  const segments = raw.segments.map((segment, index) => {
    if (!segment || typeof segment !== "object") throw new Error(`segments[${index}]가 객체가 아닙니다.`);
    if (typeof segment.id !== "string" || !SEGMENT_ID_RE.test(segment.id) || ids.has(segment.id)) {
      throw new Error(`segments[${index}].id가 없거나 중복되었습니다.`);
    }
    ids.add(segment.id);
    if (segment.mode !== "overlay" && segment.mode !== "extended") throw new Error(`segments[${index}].mode가 올바르지 않습니다.`);
    const triggerMs = assertInteger(segment.trigger_ms, `segments[${index}].trigger_ms`);
    if (triggerMs < previousTrigger) throw new Error("segments의 trigger_ms가 정렬되지 않았습니다.");
    if (triggerMs > raw.video.duration_ms) throw new Error(`segments[${index}]가 영상 duration을 벗어납니다.`);
    previousTrigger = triggerMs;
    if (segment.importance !== "normal" && segment.importance !== "high") throw new Error(`segments[${index}].importance가 올바르지 않습니다.`);
    if (segment.mode === "extended") {
      if (segment.importance !== "high") throw new Error("extended는 high 중요도만 재생할 수 있습니다.");
      if (triggerMs - previousExtended < playback.min_extended_interval_ms) throw new Error("extended 세그먼트 간격이 너무 짧습니다.");
      previousExtended = triggerMs;
    }
    if (typeof segment.text !== "string" || !segment.text.trim()) throw new Error(`segments[${index}].text가 없습니다.`);
    if (!SOURCE_VALUES.has(segment.source)) throw new Error(`segments[${index}].source가 올바르지 않습니다.`);
    if (!CONFIDENCE_VALUES.has(segment.confidence)) throw new Error(`segments[${index}].confidence가 올바르지 않습니다.`);
    if (!segment.audio || typeof segment.audio !== "object") throw new Error(`segments[${index}].audio가 없습니다.`);
    const durationMs = assertInteger(segment.audio.duration_ms, `segments[${index}].audio.duration_ms`, 1);
    let deadlineMs = null;
    if (segment.mode === "overlay") {
      deadlineMs = assertInteger(segment.deadline_ms, `segments[${index}].deadline_ms`, 1);
      if (deadlineMs <= triggerMs || deadlineMs > raw.video.duration_ms) throw new Error(`segments[${index}].deadline_ms가 올바르지 않습니다.`);
      if (durationMs > deadlineMs - triggerMs) throw new Error(`segments[${index}]의 음원이 자연 무음 구간보다 깁니다.`);
    } else if (durationMs > playback.max_extended_duration_ms) {
      throw new Error(`segments[${index}]의 extended 음원이 최대 길이를 넘습니다.`);
    }
    if (typeof segment.audio.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(segment.audio.sha256)) {
      throw new Error(`segments[${index}].audio.sha256이 올바르지 않습니다.`);
    }
    const pathMatch = typeof segment.audio.path === "string" ? segment.audio.path.match(AUDIO_PATH_RE) : null;
    if (!pathMatch || pathMatch[1] !== segment.audio.sha256) {
      throw new Error(`segments[${index}].audio.path가 sha256 경로와 일치하지 않습니다.`);
    }
    return {
      ...segment,
      start_ms: triggerMs,
      end_ms: deadlineMs ?? triggerMs + Math.min(LATE_SKIP_MS, playback.late_tolerance_ms) + 1,
    };
  });

  return {
    ...raw,
    segments,
    playback: {
      ...playback,
      late_tolerance_ms: Math.min(LATE_SKIP_MS, playback.late_tolerance_ms),
    },
  };
}

function firstCandidateIndex(currentMs) {
  const segments = state.manifest ? state.manifest.segments : [];
  let low = 0;
  let high = segments.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (segments[mid].end_ms <= currentMs) low = mid + 1;
    else high = mid;
  }
  return low;
}

function segmentById(segmentId) {
  if (!state.manifest) return null;
  return state.manifest.segments.find((segment) => segment.id === segmentId) || null;
}

function preloadAhead() {
  if (!state.enabled || !state.manifest || !state.videoKey) return;
  const count = state.manifest.playback.preload_count;
  const ids = state.manifest.segments
    .slice(state.nextIndex, state.nextIndex + count)
    .map((segment) => segment.id)
    .filter((id) => !state.preloaded.has(id));
  if (!ids.length) return;
  const generation = state.generation;
  sendMessage({
    type: "AUDIO_PRELOAD",
    video_key: state.videoKey,
    revision: state.revision,
    segment_ids: ids,
    request_id: requestId("preload"),
  })
    .then((response) => {
      if (generation !== state.generation || !response || response.type !== "PRELOAD_RESULT") return;
      for (const id of response.loaded || []) state.preloaded.add(id);
    })
    .catch(() => {});
}

function scheduleFromCurrent(reason = "schedule") {
  clearTimer("schedulerTimer");
  if (state.stopPromise) {
    state.stopPromise.finally(() => scheduleFromCurrent(reason));
    return;
  }
  if (!state.enabled || !state.video || !state.manifest || state.video.paused || state.video.muted || state.video.ended || state.video.seeking) return;
  if (state.scheduledSegmentId || state.activeSegmentId || state.pausedAudio) return;

  const currentMs = Math.round(state.video.currentTime * 1000);
  const lateTolerance = Math.min(LATE_SKIP_MS, state.manifest.playback.late_tolerance_ms);
  while (state.nextIndex < state.manifest.segments.length) {
    const segment = state.manifest.segments[state.nextIndex];
    const lateness = currentMs - segment.start_ms;
    const expectedStart = Math.max(currentMs, segment.start_ms);
    if (
      (segment.mode === "overlay" && segment.end_ms <= currentMs) ||
      lateness > lateTolerance ||
      (segment.mode === "overlay" && expectedStart + segment.audio.duration_ms > segment.end_ms) ||
      (segment.mode === "extended" && !state.autoPause)
    ) {
      console.info("[들리는 화면] segment skip", { segment_id: segment.id, reason, lateness_ms: lateness });
      state.nextIndex += 1;
      continue;
    }
    break;
  }

  if (state.nextIndex >= state.manifest.segments.length) {
    reportStatus("ready", null);
    return;
  }

  preloadAhead();
  const segment = state.manifest.segments[state.nextIndex];
  const deltaVideoMs = segment.start_ms - currentMs;
  const playbackRate = clamp(state.video.playbackRate || 1, 0.25, 4);
  const lookaheadMs = state.manifest.playback.lookahead_ms;
  if (deltaVideoMs > lookaheadMs) {
    const wakeInMs = Math.max(25, Math.round((deltaVideoMs - lookaheadMs) / playbackRate));
    state.schedulerTimer = setTimeout(() => scheduleFromCurrent("lookahead"), wakeInMs);
    return;
  }

  const delayMs = Math.max(0, Math.round(deltaVideoMs / playbackRate));
  void playSegment(segment, delayMs, playbackRate);
}

async function playSegment(segment, delayMs, playbackRate) {
  if (!state.enabled || state.scheduledSegmentId || state.activeSegmentId) return;
  const generation = state.generation;
  state.scheduledSegmentId = segment.id;
  state.audioStarted = false;
  state.nextIndex += 1;
  reportStatus("scheduled", null);
  try {
    const response = await sendMessage({
      type: "AUDIO_PLAY",
      video_key: state.videoKey,
      revision: state.revision,
      segment_id: segment.id,
      delay_ms: delayMs,
      playback_rate: playbackRate,
      request_id: requestId("play"),
    });
    if (generation !== state.generation || state.scheduledSegmentId !== segment.id) return;
    if (!response || response.type === "AUDIO_ERROR" || response.type === "ERROR") {
      throw new Error(response && response.error ? response.error.message : "오디오 재생 요청 실패");
    }
    clearTimer("startWatchdog");
    state.startWatchdog = setTimeout(() => {
      if (state.scheduledSegmentId === segment.id && !state.audioStarted) {
        void stopAudio("start-timeout");
        scheduleFromCurrent("start-timeout");
      }
    }, delayMs + 1500);
  } catch (error) {
    if (generation !== state.generation) return;
    state.scheduledSegmentId = null;
    state.audioStarted = false;
    restoreVolume();
    reportStatus("error", error instanceof Error ? error.message : String(error));
    state.schedulerTimer = setTimeout(() => scheduleFromCurrent("play-error"), 100);
  }
}

function handleAudioStarted(message) {
  if (!state.enabled || !state.video || state.video.muted) {
    restoreVolume();
    void stopAudio("muted");
    return;
  }
  if (message.scheduled) return;
  const segmentId = message.segment_id;
  if (segmentId !== state.scheduledSegmentId && (!state.pausedAudio || segmentId !== state.pausedAudio.segment_id)) return;
  clearTimer("startWatchdog");
  state.scheduledSegmentId = null;
  state.activeSegmentId = segmentId;
  state.audioStarted = true;
  state.pausedAudio = null;
  const segment = segmentById(segmentId);
  if (segment && segment.mode === "extended") {
    const owned = !state.video.paused;
    state.extendedPause = { segment_id: segmentId, owned, user_intervened: false };
    if (owned) {
      state.suppressPauseEvent = true;
      state.video.pause();
    }
    restoreVolume();
  } else {
    beginDucking();
  }
  reportStatus("playing", null);
}

function finishExtendedPause(segmentId, allowResume = true) {
  const pause = state.extendedPause;
  state.extendedPause = null;
  state.suppressPauseEvent = false;
  if (
    allowResume && pause && pause.segment_id === segmentId && pause.owned &&
    !pause.user_intervened && state.video && state.video.paused && !state.video.ended
  ) {
    state.video.play().catch(() => {});
  }
}

function handleAudioEnded(message) {
  const segmentId = message.segment_id;
  if (segmentId !== state.activeSegmentId && segmentId !== state.scheduledSegmentId) return;
  clearTimer("startWatchdog");
  restoreVolume();
  state.activeSegmentId = null;
  state.scheduledSegmentId = null;
  state.audioStarted = false;
  state.pausedAudio = null;
  finishExtendedPause(segmentId, true);
  reportStatus("ready", null);
  scheduleFromCurrent("audio-ended");
}

function handleAudioError(message) {
  if (message.segment_id && message.segment_id !== state.activeSegmentId && message.segment_id !== state.scheduledSegmentId) return;
  clearTimer("startWatchdog");
  restoreVolume();
  state.activeSegmentId = null;
  state.scheduledSegmentId = null;
  state.audioStarted = false;
  state.pausedAudio = null;
  finishExtendedPause(message.segment_id, true);
  const messageText = message.error && message.error.message ? message.error.message : "오디오 재생 오류";
  reportStatus("error", messageText);
  state.schedulerTimer = setTimeout(() => scheduleFromCurrent("audio-error"), 100);
}

function handleAudioStopped(message) {
  const pausedSegmentId = state.pausedAudio && state.pausedAudio.segment_id;
  if (
    message.segment_id &&
    message.segment_id !== state.activeSegmentId &&
    message.segment_id !== state.scheduledSegmentId &&
    message.segment_id !== pausedSegmentId
  ) {
    return;
  }
  clearTimer("startWatchdog");
  restoreVolume();
  state.activeSegmentId = null;
  state.scheduledSegmentId = null;
  state.audioStarted = false;
  state.pausedAudio = null;
  finishExtendedPause(message.segment_id, message.reason !== "user-intervention");
}

async function pauseActiveAudio(reason) {
  const generation = state.generation;
  clearSchedulingTimers();
  restoreVolume();
  if (state.scheduledSegmentId && !state.audioStarted) {
    await stopAudio(reason);
    if (state.video && state.manifest) state.nextIndex = firstCandidateIndex(Math.round(state.video.currentTime * 1000));
    return;
  }
  if (!state.activeSegmentId) return;
  const segmentId = state.activeSegmentId;
  try {
    const response = await sendMessage({ type: "AUDIO_PAUSE", segment_id: segmentId, request_id: requestId("pause") });
    if (generation !== state.generation || !state.enabled) return;
    if (response && response.type === "AUDIO_PAUSED") {
      state.pausedAudio = { segment_id: segmentId, offset_ms: response.offset_ms || 0 };
      state.activeSegmentId = null;
      state.audioStarted = false;
    } else {
      await stopAudio(reason);
    }
  } catch (_error) {
    await stopAudio(reason);
  }
}

async function resumePausedAudio() {
  if (!state.pausedAudio || !state.video || state.video.muted || !state.manifest) return false;
  const generation = state.generation;
  const paused = state.pausedAudio;
  const segment = segmentById(paused.segment_id);
  const currentMs = Math.round(state.video.currentTime * 1000);
  const expectedVideoMs = segment ? segment.start_ms + paused.offset_ms : 0;
  if (
    !segment ||
    Math.abs(currentMs - expectedVideoMs) > LATE_SKIP_MS ||
    currentMs + (segment.audio.duration_ms - paused.offset_ms) > segment.end_ms
  ) {
    state.pausedAudio = null;
    state.nextIndex = firstCandidateIndex(currentMs);
    return false;
  }
  try {
    const response = await sendMessage({
      type: "AUDIO_RESUME",
      segment_id: paused.segment_id,
      offset_ms: paused.offset_ms,
      playback_rate: clamp(state.video.playbackRate || 1, 0.25, 4),
      request_id: requestId("resume"),
    });
    if (generation !== state.generation || !state.enabled) return false;
    if (response && response.type === "AUDIO_STARTED") {
      handleAudioStarted({ ...response, scheduled: false });
      return true;
    }
  } catch (_error) {
    // 아래에서 다음 segment를 다시 계산한다.
  }
  state.pausedAudio = null;
  state.nextIndex = firstCandidateIndex(currentMs);
  return false;
}

async function stopAudio(reason) {
  clearSchedulingTimers();
  restoreVolume();
  const hadAudio = state.activeSegmentId || state.scheduledSegmentId || state.pausedAudio;
  state.activeSegmentId = null;
  state.scheduledSegmentId = null;
  state.audioStarted = false;
  state.pausedAudio = null;
  if (state.extendedPause) finishExtendedPause(state.extendedPause.segment_id, reason !== "user-intervention");
  if (!hadAudio) return state.stopPromise;
  if (state.stopPromise) return state.stopPromise;
  state.stopPromise = sendMessage({ type: "AUDIO_STOP", reason, request_id: requestId("stop") })
    .catch(() => {
      // background도 disable/navigation 시 엔진을 정리하므로 로컬 복구를 우선한다.
    })
    .finally(() => {
      state.stopPromise = null;
    });
  return state.stopPromise;
}

function resetManifestState() {
  clearTimer("processingTimer");
  clearSchedulingTimers();
  state.manifest = null;
  state.videoKey = null;
  state.revision = null;
  state.nextIndex = 0;
  state.requestId = null;
  state.preloaded = new Set();
}

async function installManifest(message) {
  if (!state.enabled || !state.video || !state.identity) return;
  if (message.video_key && message.video_key !== state.identity.video_key) return;
  if (!message.video_key && message.request_id && state.requestId && message.request_id !== state.requestId) return;
  const durationMs = stableDurationMs(state.video, state.identity);
  if (!durationMs) {
    reportStatus("waiting-video", null);
    retryAfterMetadataSettles();
    return;
  }
  try {
    const manifest = validateManifest(message.manifest, { ...state.identity, duration_ms: durationMs });
    if (message.video_key !== state.identity.video_key || message.revision !== manifest.revision) {
      throw new Error("MANIFEST_READY 메타데이터가 본문과 일치하지 않습니다.");
    }
    if (state.revision !== null && state.revision !== manifest.revision) await stopAudio("revision-change");
    clearTimer("processingTimer");
    state.manifest = manifest;
    state.videoKey = message.video_key;
    state.revision = manifest.revision;
    state.preloaded = new Set();
    state.nextIndex = firstCandidateIndex(Math.round(state.video.currentTime * 1000));
    reportStatus(state.video.muted ? "muted" : state.video.paused ? "paused" : "ready", null);
    preloadAhead();
    scheduleFromCurrent("manifest-ready");
  } catch (error) {
    await stopAudio("manifest-invalid");
    restoreVolume();
    resetManifestState();
    reportStatus("error", error instanceof Error ? error.message : String(error));
  }
}

function handleProcessing(message) {
  if (!state.enabled || !state.identity) return;
  if (message.video_key && message.video_key !== state.identity.video_key) return;
  if (!message.video_key && message.request_id && state.requestId && message.request_id !== state.requestId) return;
  reportStatus("processing", null);
  clearTimer("processingTimer");
  const retryMs = Number.isFinite(message.retry_after_ms) ? clamp(Math.round(message.retry_after_ms), 500, 5000) : 1500;
  state.processingTimer = setTimeout(() => void requestManifest(), retryMs);
}

async function requestManifest() {
  if (!state.enabled || !state.video || !state.identity) return;
  const durationMs = stableDurationMs(state.video, state.identity);
  if (!durationMs) {
    reportStatus("waiting-video", null);
    retryAfterMetadataSettles();
    return;
  }
  const id = requestId("manifest");
  state.requestId = id;
  reportStatus("loading", null);
  try {
    const response = await sendMessage({
      type: "MANIFEST_GET",
      provider: state.identity.provider,
      video_id: state.identity.video_id,
      duration_ms: durationMs,
      request_id: id,
    });
    if (!state.enabled || state.requestId !== id || !response) return;
    if (response.type === "MANIFEST_READY") await installManifest(response);
    else if (response.type === "PROCESSING") handleProcessing(response);
    else {
      const message = response.error && response.error.message ? response.error.message : "매니페스트 요청 실패";
      reportStatus("error", message);
    }
  } catch (error) {
    if (state.requestId === id) reportStatus("error", error instanceof Error ? error.message : String(error));
  }
}

async function bindCurrentVideo(reason) {
  if (!state.enabled) return;
  const identity = extractYouTubeIdentity();
  const video = findYouTubeVideo();
  if (!identity || !video) {
    if (state.video || state.identity || state.manifest) {
      state.generation += 1;
      await stopAudio(reason || "navigation");
      restoreVolume();
      detachVideoListeners(state.video);
      resetManifestState();
      state.video = null;
      state.identity = null;
      state.volume = null;
      resetDurationProbe();
    }
    reportStatus("waiting-video", null);
    return;
  }
  if (state.video === video && state.identity && state.identity.video_key === identity.video_key) {
    if (!state.manifest && !state.processingTimer) void requestManifest();
    return;
  }

  state.generation += 1;
  await stopAudio(reason || "video-replace");
  restoreVolume();
  detachVideoListeners(state.video);
  resetManifestState();
  state.video = video;
  state.identity = identity;
  resetDurationProbe();
  initializeVolumeState(video);
  attachVideoListeners(video);
  void requestManifest();
}

function scheduleReconcile(reason) {
  if (!state.enabled) return;
  if (state.reconcileTimer) return;
  state.reconcileTimer = setTimeout(() => {
    state.reconcileTimer = null;
    void bindCurrentVideo(reason);
  }, 200);
}

async function enableFeature(duckFactor, autoPause) {
  state.enabled = true;
  state.duckFactor = Number.isFinite(duckFactor) ? clamp(duckFactor, 0.1, 1) : state.duckFactor;
  if (typeof autoPause === "boolean") state.autoPause = autoPause;
  reportStatus("loading", null);
  await bindCurrentVideo("enable");
}

async function disableFeature(reason = "disable") {
  state.enabled = false;
  state.generation += 1;
  clearTimer("reconcileTimer");
  clearTimer("processingTimer");
  await stopAudio(reason);
  restoreVolume();
  detachVideoListeners(state.video);
  state.video = null;
  state.identity = null;
  state.volume = null;
  resetDurationProbe();
  resetManifestState();
}

function resumeOrSchedule(reason) {
  if (state.resumePromise) return;
  state.resumePromise = (async () => {
    if (await resumePausedAudio()) return;
    scheduleFromCurrent(reason);
  })().finally(() => {
    state.resumePromise = null;
  });
}

function onVideoPlay() {
  if (!state.enabled) return;
  if (state.extendedPause && state.activeSegmentId === state.extendedPause.segment_id) {
    state.extendedPause.user_intervened = true;
    void stopAudio("user-intervention");
    return;
  }
  resumeOrSchedule("play");
}

function onVideoPlaying() {
  onVideoPlay();
}

function onVideoPause() {
  if (!state.enabled || (state.video && state.video.ended)) return;
  if (state.suppressPauseEvent) {
    state.suppressPauseEvent = false;
    return;
  }
  if (state.extendedPause) return;
  void pauseActiveAudio("pause").then(() => reportStatus("paused", null));
}

function onVideoWaiting() {
  if (!state.enabled) return;
  void pauseActiveAudio("waiting");
}

function onVideoSeeking() {
  if (!state.enabled) return;
  void stopAudio("seek");
  restoreVolume();
}

function onVideoSeeked() {
  if (!state.enabled || !state.video || !state.manifest) return;
  state.nextIndex = firstCandidateIndex(Math.round(state.video.currentTime * 1000));
  preloadAhead();
  scheduleFromCurrent("seeked");
}

function onVideoRateChange() {
  if (!state.enabled || !state.video) return;
  void (async () => {
    if (state.activeSegmentId) {
      await pauseActiveAudio("ratechange");
      if (!state.video.paused) await resumePausedAudio();
    } else if (state.scheduledSegmentId) {
      await stopAudio("ratechange");
      if (state.manifest) state.nextIndex = firstCandidateIndex(Math.round(state.video.currentTime * 1000));
      scheduleFromCurrent("ratechange");
    }
  })();
}

function onVideoEnded() {
  if (!state.enabled) return;
  void stopAudio("ended").then(() => reportStatus("ended", null));
}

function onVideoMetadata() {
  if (!state.enabled || !state.video) return;
  const durationMs = stableDurationMs(state.video, state.identity);
  if (!durationMs) {
    retryAfterMetadataSettles();
    return;
  }
  if (state.manifest && Math.abs(state.manifest.video.duration_ms - durationMs) > MAX_DURATION_DRIFT_MS) {
    void stopAudio("duration-change").then(() => {
      resetManifestState();
      void requestManifest();
    });
  } else if (!state.manifest && !state.processingTimer) {
    void requestManifest();
  }
}

function onVideoEmptied() {
  scheduleReconcile("video-replace");
}

function onVideoTimeUpdate() {
  if (!state.enabled || !state.manifest || state.activeSegmentId || state.scheduledSegmentId || state.schedulerTimer) return;
  scheduleFromCurrent("timeupdate");
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return undefined;
  if (message.type === "PANEL_PING") {
    const identity = extractYouTubeIdentity();
    sendResponse({
      supported: !!identity,
      video_id: identity ? identity.video_id : null,
      title: document.title || null,
    });
    return undefined;
  }
  if (message.type === "FEATURE_ENABLE") {
    void enableFeature(message.duck_factor, message.auto_pause);
    sendResponse({ ok: true });
    return undefined;
  }
  if (message.type === "FEATURE_DISABLE") {
    restoreVolume();
    void disableFeature(message.reason || "disable");
    sendResponse({ ok: true });
    return undefined;
  }
  if (message.type === "SETTINGS_UPDATED") {
    if (Number.isFinite(message.duck_factor)) {
      state.duckFactor = clamp(message.duck_factor, 0.1, 1);
      if (state.volume && state.volume.isDucking) writeVideoVolume(state.volume.userVolume * state.duckFactor);
    }
    if (typeof message.auto_pause === "boolean") state.autoPause = message.auto_pause;
    return undefined;
  }
  if (message.type === "MANIFEST_READY") {
    void installManifest(message);
    return undefined;
  }
  if (message.type === "PROCESSING") {
    handleProcessing(message);
    return undefined;
  }
  if (message.type === "ERROR") {
    if (!message.request_id || !state.requestId || message.request_id === state.requestId) {
      reportStatus("error", message.error && message.error.message ? message.error.message : "확장 오류");
    }
    return undefined;
  }
  if (message.type === "AUDIO_STARTED") handleAudioStarted(message);
  if (message.type === "AUDIO_ENDED") handleAudioEnded(message);
  if (message.type === "AUDIO_ERROR") handleAudioError(message);
  if (message.type === "AUDIO_STOPPED") handleAudioStopped(message);
  if (message.type === "AUDIO_PAUSED" && state.activeSegmentId === message.segment_id) {
    restoreVolume();
    state.pausedAudio = { segment_id: message.segment_id, offset_ms: message.offset_ms || 0 };
    state.activeSegmentId = null;
    state.audioStarted = false;
  }
  return undefined;
});

const pageObserver = new MutationObserver(() => scheduleReconcile("video-replace"));
if (document.documentElement) pageObserver.observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener("yt-navigate-finish", () => scheduleReconcile("navigation"));
window.addEventListener("popstate", () => scheduleReconcile("navigation"));
window.addEventListener("pagehide", () => {
  restoreVolume();
  if (state.enabled) sendMessage({ type: "AUDIO_STOP", reason: "pagehide", request_id: requestId("stop") }).catch(() => {});
});

sendMessage({ type: "STATE_GET" })
  .then((response) => {
    if (response && response.enabled) void enableFeature(response.duck_factor);
  })
  .catch(() => {});
